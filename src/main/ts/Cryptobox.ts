import * as Proteus from "wire-webapp-proteus";
import {LRUCache} from "wire-webapp-lru-cache";
import {CryptoboxSession} from "./CryptoboxSession";
import {CryptoboxStore} from "./store/CryptoboxStore";
import {ReadOnlyStore} from "./store/ReadOnlyStore";
import Logdown = require("logdown");
import postal = require("postal");

export class Cryptobox {
  public CHANNEL_CRYPTOBOX: string;
  public TOPIC_NEW_PREKEYS: string;

  private lastResortPreKey: Proteus.keys.PreKey;
  private cachedSessions: LRUCache;
  private channel;

  private logger: Logdown;
  private minimumAmountOfPreKeys: number;
  private pk_store: ReadOnlyStore;
  private store: CryptoboxStore;

  public identity: Proteus.keys.IdentityKeyPair;

  constructor(cryptoBoxStore: CryptoboxStore, minimumAmountOfPreKeys: number = 1) {
    if (!cryptoBoxStore) {
      throw new Error(`You cannot initialize Cryptobox without a storage component.`);
    }

    this.logger = new Logdown({prefix: 'cryptobox.Cryptobox', alignOuput: true});

    this.cachedSessions = new LRUCache(1000);
    this.channel = postal.channel(this.CHANNEL_CRYPTOBOX);
    this.logger.log(`Prepared event channel "${this.CHANNEL_CRYPTOBOX}".`);

    this.minimumAmountOfPreKeys = minimumAmountOfPreKeys;
    this.store = cryptoBoxStore;
    this.pk_store = new ReadOnlyStore(this.store);

    let storageEngine: string = (<any>cryptoBoxStore).constructor.name;
    this.logger.log(`Constructed Cryptobox. Minimum amount of PreKeys is "${minimumAmountOfPreKeys}". Storage engine is "${storageEngine}".`);
  }

  private save_session_in_cache(session: CryptoboxSession): CryptoboxSession {
    this.logger.log(`Saving Session with ID "${session.id}" in cache.`);
    this.cachedSessions.set(session.id, session);
    return session;
  }

  private load_session_from_cache(session_id: string): CryptoboxSession {
    this.logger.log(`Loading Session with ID "${session_id}" from cache.`);
    return this.cachedSessions.get(session_id);
  }

  public remove_session_from_cache(session_id: string): void {
    this.logger.log(`Removing Session with ID "${session_id}" from cache.`);
    this.cachedSessions.set(session_id, undefined);
  }

  public init(): Promise<Array<Proteus.keys.PreKey>> {
    return Promise.resolve().then(() => {
      this.logger.log(`Loading local identity...`);
      return this.store.load_identity()
        .catch(() => {
          let identity: Proteus.keys.IdentityKeyPair = Proteus.keys.IdentityKeyPair.new();
          this.logger.warn(`No existing identity found. Created new identity with fingerprint "${identity.public_key.fingerprint()}".`, identity);
          return this.store.save_identity(identity);
        })
        .then((identity: Proteus.keys.IdentityKeyPair) => {
          this.identity = identity;
          this.logger.log(`Loaded local identity. Fingerprint is "${this.identity.public_key.fingerprint()}".`, this.identity);
          this.logger.log(`Loading Last Resort PreKey with ID "${Proteus.keys.PreKey.MAX_PREKEY_ID}"...`);
          return this.store.load_prekey(Proteus.keys.PreKey.MAX_PREKEY_ID);
        })
        .catch((error: Error) => {
          let lastResortID: number = Proteus.keys.PreKey.MAX_PREKEY_ID;
          this.logger.warn(`No last resort PreKey found: ${error.message}`);
          return this.new_last_resort_prekey(lastResortID);
        })
        .then((lastResortPreKey: Proteus.keys.PreKey) => {
          this.logger.log(`Loaded Last Resort PreKey with ID "${lastResortPreKey.key_id}".`);
          this.logger.log(`Loading "${this.minimumAmountOfPreKeys - 1}" Standard PreKeys...`);
          return this.refill_prekeys(false);
        })
        .then((allPreKeys: Array<Proteus.keys.PreKey>) => {
          this.logger.log(`Initialized Cryptobox with a total amount of "${allPreKeys.length}" PreKeys.`);
          return allPreKeys;
        });
    });
  }

  /**
   * This method returns all PreKeys available, respecting the minimum required amount of PreKeys.
   * If all available PreKeys don't meet the minimum PreKey amount, new PreKeys will be created.
   */
  private refill_prekeys(publish_new_prekeys: boolean = true): Promise<Array<Proteus.keys.PreKey>> {
    return Promise.resolve().then(() => {
      let allPreKeys: Array<Proteus.keys.PreKey> = [];

      return this.store.load_prekeys()
        .then((preKeysFromStorage: Array<Proteus.keys.PreKey>) => {
          allPreKeys = preKeysFromStorage;

          let missingAmount: number = 0;
          let highestId: number = 0;

          if (preKeysFromStorage.length < this.minimumAmountOfPreKeys) {
            missingAmount = this.minimumAmountOfPreKeys - preKeysFromStorage.length;
            highestId = -1;

            preKeysFromStorage.forEach((preKey: Proteus.keys.PreKey) => {
              if (preKey.key_id > highestId && preKey.key_id !== Proteus.keys.PreKey.MAX_PREKEY_ID) {
                highestId = preKey.key_id;
              }
            });

            highestId += 1;

            this.logger.warn(`There are not enough PreKeys in the storage. Generating "${missingAmount}" new PreKey(s), starting from ID "${highestId}"...`)
          }

          return this.new_prekeys(highestId, missingAmount);
        })
        .then((newPreKeys: Array<Proteus.keys.PreKey>) => {
          allPreKeys = allPreKeys.concat(newPreKeys);

          if (newPreKeys.length > 0) {
            this.logger.log(`Genereated PreKeys from ID "${newPreKeys[0].key_id}" to ID "${newPreKeys[newPreKeys.length - 1].key_id}".`);
            if (publish_new_prekeys) {
              this.channel.publish(this.TOPIC_NEW_PREKEYS, newPreKeys);
              this.logger.log(`Published event "${this.CHANNEL_CRYPTOBOX}:${this.TOPIC_NEW_PREKEYS}".`, newPreKeys);
            }
          }

          return allPreKeys;
        });
    });
  }

  public session_from_prekey(client_id: string, pre_key_bundle: ArrayBuffer): Promise<CryptoboxSession> {
    return Promise.resolve().then(() => {
      let bundle: Proteus.keys.PreKeyBundle = Proteus.keys.PreKeyBundle.deserialise(pre_key_bundle);
      return Proteus.session.Session.init_from_prekey(this.identity, bundle).then((session: Proteus.session.Session) => {
        return new CryptoboxSession(client_id, this.pk_store, session);
      });
    });
  }

  public session_from_message(session_id: string, envelope: ArrayBuffer): Promise<(CryptoboxSession | Uint8Array)[]> {
    return Promise.resolve().then(() => {
      let env: Proteus.message.Envelope;
      env = Proteus.message.Envelope.deserialise(envelope);

      return Proteus.session.Session.init_from_message(this.identity, this.pk_store, env)
        .then((tuple: Proteus.session.SessionFromMessageTuple) => {
          let session: Proteus.session.Session = tuple[0];
          let decrypted: Uint8Array = tuple[1];
          let cryptoBoxSession: CryptoboxSession = new CryptoboxSession(session_id, this.pk_store, session);
          return [cryptoBoxSession, decrypted];
        })
    });
  }

  public session_load(session_id: string): Promise<CryptoboxSession> {
    return Promise.resolve().then(() => {
      let cachedSession = this.load_session_from_cache(session_id);
      if (cachedSession) {
        return cachedSession;
      }

      return this.store.load_session(this.identity, session_id)
        .then((session: Proteus.session.Session) => {
          if (session) {
            return new CryptoboxSession(session_id, this.pk_store, session);
          } else {
            throw new Error(`Session with ID "${session}" not found.`);
          }
        })
        .then(function (session) {
          return this.save_session_in_cache(session);
        });
    });
  }

  public session_save(session: CryptoboxSession): Promise<String> {
    return this.store.save_session(session.id, session.session).then(() => {
      let prekey_deletions = this.pk_store.removed_prekeys.map((preKeyId: number) => {
        return this.store.delete_prekey(preKeyId);
      });

      return Promise.all(prekey_deletions);
    }).then(() => {
      // Create new PreKeys (to respect the minimum amount of required PreKeys)
      return this.refill_prekeys();
    }).then(() => {
      return this.save_session_in_cache(session);
    }).then(() => {
      return session.id;
    });
  }

  public session_delete(session_id: string): Promise<string> {
    this.remove_session_from_cache(session_id);
    return this.store.delete_session(session_id);
  }

  public new_last_resort_prekey(prekey_id: number): Promise<Proteus.keys.PreKey> {
    return Promise.resolve()
      .then(() => {
        this.lastResortPreKey = Proteus.keys.PreKey.last_resort();
        return this.store.save_prekeys([this.lastResortPreKey]);
      }).then((preKeys: Array<Proteus.keys.PreKey>) => {
        return preKeys[0];
      });
  }

  public serialize_prekey(prekey: Proteus.keys.PreKey): Object {
    return Proteus.keys.PreKeyBundle.new(this.identity.public_key, prekey).serialised_json();
  }

  /**
   * Creates new PreKeys and saves them into the storage.
   */
  public new_prekeys(start: number, size: number = 0): Promise<Array<Proteus.keys.PreKey>> {
    return Promise.resolve().then(() => {
      if (size === 0) {
        return [];
      }

      let newPreKeys: Array<Proteus.keys.PreKey> = Proteus.keys.PreKey.generate_prekeys(start, size);
      return this.store.save_prekeys(newPreKeys);
    });
  }

  public encrypt(session: CryptoboxSession|string, payload: string|Uint8Array): Promise<ArrayBuffer> {
    let encryptedBuffer: ArrayBuffer;
    let loadedSession: CryptoboxSession;

    return Promise.resolve().then(() => {
      if (typeof session === 'string') {
        return this.session_load(session);
      }
      return session;
    }).then((session: CryptoboxSession) => {
      loadedSession = session;
      return loadedSession.encrypt(payload);
    }).then((encrypted: ArrayBuffer) => {
      encryptedBuffer = encrypted;
      return this.session_save(loadedSession);
    }).then(function () {
      return encryptedBuffer;
    });
  }

  public decrypt(session_id: string, ciphertext: ArrayBuffer): Promise<Uint8Array> {
    let message: Uint8Array;
    let session: CryptoboxSession;

    return this.session_load(session_id)
      .catch(() => {
        return this.session_from_message(session_id, ciphertext);
      })
      // TODO: "value" can be of type CryptoboxSession | Array[CryptoboxSession, Uint8Array]
      .then(function (value: any) {
        let decrypted_message: Uint8Array;

        if (value[0] !== undefined) {
          [session, decrypted_message] = value;
          return decrypted_message;
        } else {
          session = value;
          return value.decrypt(ciphertext);
        }
      })
      .then((decrypted_message) => {
        message = decrypted_message;
        return this.session_save(session);
      })
      .then(() => {
        return message;
      });
  }
}

Cryptobox.prototype.CHANNEL_CRYPTOBOX = "cryptobox";
Cryptobox.prototype.TOPIC_NEW_PREKEYS = "new-prekeys";
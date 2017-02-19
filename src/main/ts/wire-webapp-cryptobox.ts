import Cache from "./store/Cache";
import IndexedDB from "./store/IndexedDB";
import {CryptoboxSession} from "./CryptoboxSession";
import {Cryptobox} from "./Cryptobox";
import {InvalidPreKeyFormatError} from "./InvalidPreKeyFormatError";
import {ReadOnlyStore} from "./store/ReadOnlyStore";
import {RecordNotFoundError} from "./store/RecordNotFoundError";

export default {
  Cryptobox: Cryptobox,
  CryptoboxSession: CryptoboxSession,
  InvalidPreKeyFormatError: InvalidPreKeyFormatError,
  store: {
    Cache,
    IndexedDB,
    ReadOnlyStore,
    RecordNotFoundError,
  },
  // Note: Path to "package.json" must be relative to the "commonjs" dist files
  version: require('../../package.json').version
}

import { hash, verify } from '@node-rs/argon2';

/** Argon2id is the library's default algorithm. A test checks that hashes really are Argon2id. */
export interface PasswordHashingOptions {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/** 64 MiB and three passes: RFC 9106's recommendation for memory-constrained environments. */
export const DEFAULT_PASSWORD_HASHING: PasswordHashingOptions = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
};

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(storedHash: string, password: string): Promise<boolean>;
  /** Does the same work as a real verification, so an unknown user takes as long as a known one. */
  verifyAgainstDummy(password: string): Promise<void>;
}

export function createPasswordHasher(
  options: PasswordHashingOptions = DEFAULT_PASSWORD_HASHING,
): PasswordHasher {
  let dummyHash: Promise<string> | undefined;
  const verifyStored = async (storedHash: string, password: string): Promise<boolean> => {
    try {
      return await verify(storedHash, password);
    } catch {
      // A malformed stored hash is a failed login, never a way in.
      return false;
    }
  };
  return {
    hash: (password) => hash(password, options),
    verify: verifyStored,
    async verifyAgainstDummy(password) {
      dummyHash ??= hash('emucat-dummy-password', options);
      await verifyStored(await dummyHash, password);
    },
  };
}

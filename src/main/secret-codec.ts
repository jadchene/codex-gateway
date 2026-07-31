export const PREFIX = "safe-storage:v1:";

interface SafeStorageAdapter {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}
export interface SecretCodec {
  isEncrypted: (value: unknown) => boolean;
  encrypt: (value: unknown) => string;
  decrypt: (value: unknown) => string;
}
export function createSecretCodec(safeStorage: SafeStorageAdapter): SecretCodec {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error("系统安全存储不可用，无法安全保存 Codex 账号 Token。");
  }
  return {
    isEncrypted(value: unknown): boolean {
      return String(value || "").startsWith(PREFIX);
    },
    encrypt(value: unknown): string {
      const text = String(value || "");
      if (!text || text.startsWith(PREFIX)) return text;
      return `${PREFIX}${safeStorage.encryptString(text).toString("base64")}`;
    },
    decrypt(value: unknown): string {
      const text = String(value || "");
      if (!text || !text.startsWith(PREFIX)) return text;
      return safeStorage.decryptString(Buffer.from(text.slice(PREFIX.length), "base64"));
    }
  };
}

const PREFIX = "safe-storage:v1:";

function createSecretCodec(safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error("系统安全存储不可用，无法安全保存 Codex 账号 Token。");
  }
  return {
    isEncrypted(value) {
      return String(value || "").startsWith(PREFIX);
    },
    encrypt(value) {
      const text = String(value || "");
      if (!text || text.startsWith(PREFIX)) return text;
      return `${PREFIX}${safeStorage.encryptString(text).toString("base64")}`;
    },
    decrypt(value) {
      const text = String(value || "");
      if (!text || !text.startsWith(PREFIX)) return text;
      return safeStorage.decryptString(Buffer.from(text.slice(PREFIX.length), "base64"));
    }
  };
}

module.exports = { createSecretCodec, PREFIX };

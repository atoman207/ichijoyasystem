// テスト用のログイン (globalThis.__testUser を操作する社員にする。本物はログインの Cookie が要るため)
module.exports = {
  SESSION_COOKIE: "ichijoya_session",
  getSessionUser: async () => globalThis.__testUser ?? null,
  requireUser: async () => {
    if (!globalThis.__testUser) throw new Error("no test user");
    return globalThis.__testUser;
  },
  createToken: () => "test",
  verifyToken: () => null,
  setSessionCookie: async () => {},
  clearSessionCookie: async () => {},
  safeNext: (n) => n || "/",
};

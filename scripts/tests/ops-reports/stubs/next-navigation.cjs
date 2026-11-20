// テスト用の next/navigation (Server Action の redirect を、URL を持った例外にする)
class Redirect extends Error {
  constructor(url) {
    super("NEXT_REDIRECT");
    this.url = url;
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}
module.exports = {
  Redirect,
  redirect: (url) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
};

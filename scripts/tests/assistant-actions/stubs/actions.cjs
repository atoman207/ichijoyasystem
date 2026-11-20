// テスト用: Server Action の代わり (画面の処理と同じく、最後に redirect を投げる)。呼ばれた入力を記録する
const calls = [];
const redirect = (url) => { const e = new Error("NEXT_REDIRECT"); e.digest = `NEXT_REDIRECT;replace;${url};307;`; throw e; };
const entries = (fd) => (fd && typeof fd.entries === "function" ? [...fd.entries()] : []);
const mk = (name, ok, fail) => async (...args) => {
  const fd = args.find((a) => a && typeof a.entries === "function");
  calls.push({ name, args: args.filter((a) => typeof a === "string"), form: entries(fd) });
  if (globalThis.__stubFail) redirect(`${fail}?err=${encodeURIComponent(globalThis.__stubFail)}`);
  redirect(`${ok}?msg=${encodeURIComponent(`${name} OK`)}`);
};
module.exports = {
  __calls: calls,
  createScheduleEvent: mk("createScheduleEvent", "/schedule/ev_new", "/schedule/new"),
  updateScheduleEvent: mk("updateScheduleEvent", "/schedule/ev_x", "/schedule/ev_x/edit"),
  deleteScheduleEvent: mk("deleteScheduleEvent", "/schedule", "/schedule/ev_x"),
  createInquiry: mk("createInquiry", "/inquiries/inq_new", "/inquiries/new"),
  setInquiryStatus: mk("setInquiryStatus", "/inquiries/inq_x", "/inquiries/inq_x"),
  addProgress: mk("addProgress", "/orders/o_x", "/orders/o_x"),
  createThread: mk("createThread", "/messages/th_new", "/messages/new"),
  decideApproval: mk("decideApproval", "/approvals", "/approvals"),
};

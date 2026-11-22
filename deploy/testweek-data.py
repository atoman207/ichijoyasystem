#!/usr/bin/env python3
"""
試験期間 (2026-11-23〜11-30) のテスト用データベース (deploy/testweek.sh から ichijoya ユーザーで実行する)
  build <アプリ>          本番のデータの控え (ndjson.gz) から JSON のデータベースを作る。添付ファイル・チャットボット・資料庫は写し
  add-missing <アプリ>    新しい版で増えた表を、空の表としてテスト用のデータベースに足す (デプロイのとき。データは変えない)
  export-inbound <出力>   期間中に外部 (LINE・Web フォーム・AI 受付・電話のシステムなど) から届いた記録を CSV に書き出す (削除の前の控え)
本番のファイル (/srv/ichijoya/data) は読むだけで書き換えない。表の一覧はアプリの src/lib/db/schema.ts の collection から作る
"""
import csv, datetime, gzip, json, os, re, shutil, sqlite3, sys

W = "/srv/ichijoya/testweek"
D = f"{W}/data"
DB = f"{D}/testweek-db.json"
SNAP = "/srv/ichijoya/data/cache/db-production.ndjson.gz"
PROD = "/srv/ichijoya/data"
SYSTEM = "system"


def collections(app):
    s = open(f"{app}/src/lib/db/schema.ts", encoding="utf-8").read()
    cols = re.findall(r'collection: "([A-Za-z]+)"', s)
    if len(cols) < 30:
        sys.exit(f"表の一覧を読めません ({app}/src/lib/db/schema.ts)")
    return cols


def write_db(db):
    tmp = DB + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o600)
    os.replace(tmp, DB)


def copy_sqlite(src, dst):
    if not os.path.exists(src):
        return
    s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    d = sqlite3.connect(dst)
    s.backup(d)
    d.close()
    s.close()


def build(app):
    if os.path.exists(D):
        shutil.rmtree(D)
    for sub in ["uploads", "cache", "database", "backups", "map-import"]:
        os.makedirs(f"{D}/{sub}", exist_ok=True)
    os.chmod(D, 0o750)
    db = {}
    with gzip.open(SNAP, "rt", encoding="utf-8") as f:
        head = json.loads(f.readline())
        for line in f:
            k, _, j = line.rstrip("\n").partition("\t")
            db.setdefault(k, []).append(json.loads(j))
    for k in collections(app):
        db.setdefault(k, [])
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db["meta"] = {**(head.get("meta") or {}), "copyOfRevision": head.get("revision"), "copyOfSavedAt": head.get("savedAt"), "copiedAt": now, "testWeek": True}
    write_db(db)
    if os.path.isdir(f"{PROD}/uploads"):
        shutil.rmtree(f"{D}/uploads")
        shutil.copytree(f"{PROD}/uploads", f"{D}/uploads")
    copy_sqlite(f"{PROD}/chatbot.sqlite", f"{D}/chatbot.sqlite")
    copy_sqlite(f"{PROD}/database/ichijoya-materials.sqlite", f"{D}/database/ichijoya-materials.sqlite")
    rows = sum(len(v) for k, v in db.items() if k != "meta")
    print(f"テスト用のデータベースを作りました: {rows} 行 (本番の控え revision {head.get('revision')}・{head.get('savedAt')})")


def add_missing(app):
    db = json.load(open(DB, encoding="utf-8"))
    added = [k for k in collections(app) if k not in db]
    if not added:
        print("増えた表はありません")
        return
    for k in added:
        db[k] = []
    write_db(db)
    print(f"新しい版で増えた表を足しました: {', '.join(added)}")


def export_inbound(out):
    if not os.path.exists(DB):
        print("テスト用のデータベースがありません")
        return
    db = json.load(open(DB, encoding="utf-8"))
    since = (db.get("meta") or {}).get("copiedAt") or "0"
    rows = []
    for i in db.get("inquiries", []):
        if i.get("createdBy") == SYSTEM and (i.get("receivedAt") or "") >= since[:19]:
            rows.append(["問い合わせ", i.get("receivedAt"), i.get("channel"), i.get("number"), i.get("contactName"), i.get("contactPhone"), i.get("summary"), (i.get("detail") or "")[:2000]])
    for c in db.get("commLogs", []):
        if c.get("userId") == SYSTEM and c.get("direction") == "inbound" and (c.get("at") or "") >= since[:19]:
            rows.append(["やりとり", c.get("at"), c.get("channel"), c.get("relatedId"), c.get("contactName"), "", c.get("subject"), (c.get("body") or "")[:2000]])
    for d in db.get("documents", []):
        if d.get("kind") == "reception" and d.get("uploadedBy") == SYSTEM and (d.get("uploadedAt") or "") >= since[:19]:
            x = d.get("extracted") or {}
            rows.append(["電話のシステム", d.get("uploadedAt"), "phone", d.get("id"), x.get("customerName"), x.get("phone"), x.get("summary"), (x.get("_text") or "")[:2000]])
    for s in db.get("settings", []):
        if s.get("id") == "line_groups":
            for g in (s.get("value") or {}).get("groups", []) or []:
                if (g.get("joinedAt") or "") >= since[:19]:
                    rows.append(["LINE グループ", g.get("joinedAt"), "line", g.get("id"), g.get("name"), "", "期間中に参加したグループ (本番ではひも付けし直す)", ""])
                for p in g.get("pending") or []:
                    if (p.get("at") or "") >= since[:19]:
                        rows.append(["LINE グループのメッセージ", p.get("at"), "line", g.get("id"), g.get("name"), "", p.get("type"), (p.get("text") or p.get("fileName") or "")[:2000]])
    rows.sort(key=lambda r: str(r[1]))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["種類", "日時 (UTC)", "入口", "番号・ID", "お名前・相手", "電話", "用件・件名", "内容"])
        w.writerows(rows)
    os.chmod(out, 0o600)
    print(f"期間中に外部から届いた記録 {len(rows)} 件を書き出しました: {out}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "build" and len(sys.argv) > 2:
        build(sys.argv[2])
    elif cmd == "add-missing" and len(sys.argv) > 2:
        add_missing(sys.argv[2])
    elif cmd == "export-inbound" and len(sys.argv) > 2:
        export_inbound(sys.argv[2])
    else:
        sys.exit(__doc__)

#!/usr/bin/env python3
"""Build a Daily Brief memo into the markdown brief and the dashboard viewer.

    python3 build.py 2026-09-25 [--dir PATH]

Reads memo-<date>.md from the briefs directory (or --dir) and writes
<date>.md and viewer-<date>.html beside it. Standard library only.

The memo is markdown: an optional "# title" line, one opening paragraph with
no heading, then "## <Label>" sections in the order curator.md gives. The
viewer keeps the envelope the dashboard parses (dashboard/app/lib/briefs.mjs):
one plain <script> holding `const ITEMS` and `const KEY`, six controls, and
the script immediately before </body></html>. One ITEMS entry per section, so
feedback is per section.
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import sys

LABELS = ["Today", "What changed", "Needs you", "Coming up", "Watch", "Caveats"]
SLUGS = {label: re.sub(r"[^a-z]+", "-", label.lower()).strip("-") for label in LABELS}
WORD_CAP = 500


class MemoError(Exception):
    pass


def parse_memo(text):
    lines = text.splitlines()
    title = None
    if lines and lines[0].startswith("# "):
        title = lines[0][2:].strip()
        lines = lines[1:]

    blocks = []  # (label or None, [paragraphs])
    current_label = None
    current_paras = []
    para = []

    def flush_para():
        if para:
            current_paras.append(" ".join(line.strip() for line in para))
            para.clear()

    for line in lines:
        if line.startswith("## "):
            flush_para()
            blocks.append((current_label, current_paras))
            current_label = line[3:].strip()
            current_paras = []
        elif line.strip() == "":
            flush_para()
        elif line.startswith("#"):
            raise MemoError(f"only '## ' headings are allowed: {line!r}")
        else:
            para.append(line)
    flush_para()
    blocks.append((current_label, current_paras))

    opening_paras = blocks[0][1]
    if len(opening_paras) != 1:
        raise MemoError(
            f"the memo opens with exactly one paragraph before the first heading; found {len(opening_paras)}"
        )
    opening = opening_paras[0]

    sections = []
    seen = []
    for label, paras in blocks[1:]:
        if label not in LABELS:
            raise MemoError(f"unknown section {label!r}; allowed: {', '.join(LABELS)}")
        if label in seen:
            raise MemoError(f"section {label!r} appears twice")
        if seen and LABELS.index(label) < LABELS.index(seen[-1]):
            raise MemoError(f"section {label!r} is out of order; the order is {', '.join(LABELS)}")
        if not paras:
            raise MemoError(f"section {label!r} is empty; omit the heading instead")
        seen.append(label)
        sections.append((label, paras))

    return title, opening, sections


def word_count(opening, sections):
    text = " ".join([opening] + [p for _, paras in sections for p in paras])
    return len(re.findall(r"\S+", text))


def default_title(date):
    day = dt.date.fromisoformat(date)
    return f"Daily Brief — {day.strftime('%A')}, {date}"


def render_markdown(title, opening, sections):
    out = [f"# {title}", "", opening, ""]
    for label, paras in sections:
        out.append(f"## {label}")
        out.append("")
        for p in paras:
            out.append(p)
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def items_for(opening, sections):
    items = [{"sec": "Opening", "id": "opening", "text": opening}]
    for label, paras in sections:
        items.append({"sec": label, "id": SLUGS[label], "text": "\n\n".join(paras)})
    return items


def render_viewer(date, title, items, words):
    # "</" inside a string would end the script element early; "<\/" is the
    # same string to JSON and harmless to the dashboard's parser.
    items_js = json.dumps(items, ensure_ascii=False).replace("</", "<\\/")
    return VIEWER.replace("{TITLE}", html.escape(title)) \
        .replace("{DATE}", date) \
        .replace("{WORDS}", str(words)) \
        .replace("{ITEMS}", items_js)


VIEWER = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily Brief — {DATE}</title>
<style>
:root{
  --bg:#fbfaf8; --ink:#1c1b19; --soft:#57544e; --faint:#8f8c85; --rule:#e6e3dd;
  --ok:#27734a; --ok-bg:rgba(39,115,74,.08);
  --no:#a2452e; --no-bg:rgba(162,69,46,.07);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){ --bg:#171715; --ink:#e8e5df; --soft:#a8a49c; --faint:#75726b; --rule:#2f2e2b;
    --ok:#68c08d; --ok-bg:rgba(104,192,141,.1); --no:#e2856a; --no-bg:rgba(226,133,106,.08); }
}
:root[data-theme="dark"]{ --bg:#171715; --ink:#e8e5df; --soft:#a8a49c; --faint:#75726b; --rule:#2f2e2b;
  --ok:#68c08d; --ok-bg:rgba(104,192,141,.1); --no:#e2856a; --no-bg:rgba(226,133,106,.08); }
*{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased}
body{margin:0;background:var(--bg);color:var(--ink);
  font:19px/1.6 Charter,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
:root[data-font="iowan"] body{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
:root[data-font="palatino"] body{font-family:"Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif}
:root[data-font="georgia"] body{font-family:Georgia,"Times New Roman",serif}
:root[data-font="sans"] body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif}
.sans{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif}
.page{max-width:46rem;margin:0 auto;padding:64px 32px 130px}
h1{font-size:25px;font-weight:600;letter-spacing:-.01em;margin:0 0 10px}
.meta{font-size:14px;line-height:1.55;color:var(--faint);margin:0}
hr{border:0;border-top:1px solid var(--rule);margin:34px 0 6px}
h2{font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  color:var(--faint);margin:22px 0 4px}
section{position:relative;margin:0;padding:2px 0 22px 14px;margin-left:-17px;
  border-left:3px solid transparent}
section.opening{font-size:21px}
section.ok{border-left-color:var(--ok)}
section.no{border-left-color:var(--no)}
section p{margin:0 0 .8em} section p:last-of-type{margin-bottom:0}
.ctl{position:absolute;left:14px;bottom:2px;opacity:0;pointer-events:none;
  display:flex;gap:14px;align-items:center;font-size:12.5px;line-height:1;transition:opacity .15s}
section:hover .ctl, section.show .ctl, section.ok .ctl, section.no .ctl, section:focus-within .ctl{
  opacity:1;pointer-events:auto}
.ctl button{background:none;border:0;padding:0;font:inherit;color:var(--faint);cursor:pointer}
.ctl button:hover{color:var(--ink)}
.ctl button.on{font-weight:700}
.ctl button.on.a{color:var(--ok)} .ctl button.on.d{color:var(--no)}
.ctl .sep{color:var(--rule)}
textarea{width:100%;margin-top:8px;background:var(--bg);color:var(--ink);
  border:1px solid var(--rule);border-radius:5px;padding:8px 10px;resize:vertical;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif}
textarea:focus{outline:none;border-color:var(--soft)}
textarea.hidden{display:none}
.overall{margin:40px 0 0}
.overall h3{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);
  font-weight:700;margin:0 0 6px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--rule);
  padding:12px 20px;display:flex;gap:16px;align-items:baseline;justify-content:center;
  font-size:13px;color:var(--soft)}
.bar button{font:inherit;font-size:13px;padding:7px 15px;border-radius:6px;
  border:1px solid var(--rule);background:transparent;color:var(--ink);cursor:pointer}
.bar button.save{border-color:var(--ok);color:var(--ok);font-weight:600}
.bar button.ghost{border:0;color:var(--faint);padding:7px 0}
.bar button:hover{border-color:var(--soft)}
.bar .prefs{margin-left:auto;display:flex;gap:14px}
.bar .prefs button{font-size:12px}
@media (max-width:560px){ .bar{flex-wrap:wrap;gap:10px 14px} .bar .prefs{margin-left:0;width:100%;justify-content:center} }
@media (max-width:560px){ body{font-size:18px} section.opening{font-size:19px} .page{padding:40px 18px 130px}
  section{margin-left:-11px;padding-left:8px} .ctl{left:8px} }
@media (hover:none){ section .ctl{opacity:.55;pointer-events:auto} }
</style>
</head>
<body>
<div class="page">
  <h1>{TITLE}</h1>
  <p class="meta sans">{WORDS} words.</p>
  <hr>
  <div id="brief"></div>
  <div class="overall">
    <h3 class="sans">Overall</h3>
    <textarea id="overall" rows="3" placeholder="Length, order, tone, anything missing entirely."></textarea>
  </div>
</div>
<div class="bar sans">
  <span id="status">No marks yet</span>
  <button class="save" onclick="saveOut()">Save feedback</button>
  <button class="ghost" onclick="copyOut()">Copy instead</button>
  <button class="ghost" onclick="clearAll()">Clear</button>
  <span class="prefs">
    <button class="ghost" id="theme" onclick="cycleTheme()">Theme: system</button>
    <button class="ghost" id="font" onclick="cycleFont()">Font: Charter</button>
  </span>
</div>
<script>
const ITEMS = {ITEMS};
const KEY = 'db-items-{DATE}';
let fb = {};
// Reading preferences, remembered across days in this browser.
const THEMES = ['system','light','dark'];
const FONTS = [['charter','Charter'],['iowan','Iowan Old Style'],['palatino','Palatino'],['georgia','Georgia'],['sans','System sans']];
function pref(k) { try { return localStorage.getItem('db-pref-'+k) || ''; } catch(e) { return ''; } }
function setPref(k, v) { try { localStorage.setItem('db-pref-'+k, v); } catch(e) {} applyPrefs(); }
function applyPrefs() {
  const t = THEMES.includes(pref('theme')) ? pref('theme') : 'system';
  const f = FONTS.some(x => x[0]===pref('font')) ? pref('font') : 'charter';
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  if (f === 'charter') root.removeAttribute('data-font'); else root.setAttribute('data-font', f);
  document.getElementById('theme').textContent = 'Theme: ' + t;
  document.getElementById('font').textContent = 'Font: ' + FONTS.find(x => x[0]===f)[1];
}
function cycleTheme() { const t = pref('theme') || 'system'; setPref('theme', THEMES[(THEMES.indexOf(t)+1) % THEMES.length]); }
function cycleFont() { const f = pref('font') || 'charter'; const i = FONTS.findIndex(x => x[0]===f); setPref('font', FONTS[(i+1) % FONTS.length][0]); }
applyPrefs();
try { fb = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch(e) {}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(fb)); } catch(e) {}
  let a=0,d=0,n=0;
  ITEMS.forEach(it => { const f = fb[it.id]||{}; if(f.m==='a') a++; if(f.m==='d') d++; if(f.n) n++; });
  document.getElementById('status').textContent =
    (a||d||n) ? `${a} approved · ${d} dismissed · ${n} note${n===1?'':'s'}` : 'No marks yet';
}

function render() {
  const host = document.getElementById('brief'); host.innerHTML = '';
  ITEMS.forEach(it => {
    if (it.sec !== 'Opening') {
      const h = document.createElement('h2'); h.className='sans'; h.textContent = it.sec; host.appendChild(h);
    }
    const f = fb[it.id] || {};
    const sec = document.createElement('section'); sec.id = 'it-'+it.id;
    if (it.sec === 'Opening') sec.classList.add('opening');
    if (f.m==='a') sec.classList.add('ok'); if (f.m==='d') sec.classList.add('no');
    it.text.split('\\n\\n').forEach(t => {
      const p = document.createElement('p'); p.textContent = t; sec.appendChild(p);
      p.onclick = () => sec.classList.toggle('show');
    });
    const c = document.createElement('div'); c.className='ctl sans';
    const ba = document.createElement('button'); ba.textContent='approve'; ba.className='a';
    const bd = document.createElement('button'); bd.textContent='dismiss'; bd.className='d';
    const bn = document.createElement('button'); bn.textContent = f.n ? 'edit note' : 'note';
    if (f.m==='a') ba.classList.add('on'); if (f.m==='d') bd.classList.add('on');
    const s1=document.createElement('span'); s1.className='sep'; s1.textContent='|';
    const s2=s1.cloneNode(true);
    const ta = document.createElement('textarea'); ta.rows=2; ta.value = f.n||'';
    ta.placeholder = 'Why, or what should have been here instead.';
    ta.className = f.n ? '' : 'hidden';
    ba.onclick = () => mark(it.id,'a');
    bd.onclick = () => mark(it.id,'d');
    bn.onclick = () => { ta.classList.toggle('hidden'); if(!ta.classList.contains('hidden')) ta.focus(); };
    ta.oninput = () => { fb[it.id] = Object.assign({}, fb[it.id], {n: ta.value.trim()||undefined});
      bn.textContent = ta.value.trim() ? 'edit note' : 'note'; persist(); };
    c.append(ba,s1,bd,s2,bn);
    sec.append(c,ta); host.appendChild(sec);
  });
  persist();
}
function mark(id, m) {
  const f = fb[id] || {};
  f.m = (f.m===m) ? undefined : m; fb[id]=f;
  const sec = document.getElementById('it-'+id);
  sec.classList.toggle('ok', f.m==='a'); sec.classList.toggle('no', f.m==='d');
  sec.querySelectorAll('.ctl button').forEach(b => b.classList.remove('on'));
  if (f.m) sec.querySelector('.ctl button.'+f.m).classList.add('on');
  persist();
}
function buildText() {
  const L = ['# Brief feedback — {DATE}', ''];
  const ov = document.getElementById('overall').value.trim();
  if (ov) L.push('## Overall','',ov,'');
  ITEMS.forEach(it => {
    L.push('## '+it.sec,'');
    const f = fb[it.id]||{};
    const tag = f.m==='a' ? 'APPROVED' : f.m==='d' ? 'DISMISSED' : 'no mark';
    L.push(`- ${tag} — ${it.text.replace(/\\s*\\n+\\s*/g,' ')}`);
    if (f.n) L.push(`  - note: ${f.n}`);
    L.push('');
  });
  return L.join('\\n') + '\\n';
}
function saveOut() {
  // Replaced by the dashboard's bridge when served there; this is the
  // fallback for opening the file directly.
  const st = document.getElementById('status'), name = 'feedback-{DATE}.md';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buildText()], {type:'text/markdown'}));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  st.textContent = 'saved to Downloads (not served by the dashboard)';
}
function copyOut() {
  navigator.clipboard.writeText(buildText())
    .then(() => { document.getElementById('status').textContent='copied'; setTimeout(persist, 2000); })
    .catch(() => { document.getElementById('status').textContent='copy blocked'; console.log(buildText()); });
}
function clearAll() { fb = {}; document.getElementById('overall').value=''; render(); }
const ov = document.getElementById('overall');
ov.value = fb._overall || '';
ov.oninput = () => { fb._overall = ov.value; persist(); };
render();
</script>
</body>
</html>
"""


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("date", help="YYYY-MM-DD")
    ap.add_argument("--dir", default=os.path.dirname(os.path.abspath(__file__)),
                    help="directory holding memo-<date>.md; outputs go beside it")
    args = ap.parse_args(argv)

    try:
        dt.date.fromisoformat(args.date)
    except ValueError:
        return fail(f"not a date: {args.date}")

    memo_path = os.path.join(args.dir, f"memo-{args.date}.md")
    try:
        with open(memo_path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        return fail(f"cannot read {memo_path}: {e.strerror}")

    try:
        title, opening, sections = parse_memo(text)
    except MemoError as e:
        return fail(str(e))
    title = title or default_title(args.date)

    words = word_count(opening, sections)
    if words > WORD_CAP:
        return fail(f"{words} words; the cap is {WORD_CAP}")

    items = items_for(opening, sections)
    md_path = os.path.join(args.dir, f"{args.date}.md")
    viewer_path = os.path.join(args.dir, f"viewer-{args.date}.html")
    write_atomic(md_path, render_markdown(title, opening, sections))
    write_atomic(viewer_path, render_viewer(args.date, title, items, words))
    print(f"built {args.date}: {words} words, {len(sections)} sections + opening")
    print(f"  {md_path}")
    print(f"  {viewer_path}")
    return 0


def write_atomic(path, text):
    """Write to a dotfile beside the target, then rename. The dashboard lists
    viewer-<date>.html by name, so it never sees a half-written viewer."""
    directory, name = os.path.split(path)
    tmp = os.path.join(directory, f".{name}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def fail(msg):
    print(f"build.py: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

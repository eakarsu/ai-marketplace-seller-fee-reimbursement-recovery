// FP59B: search/filter, export, deterministic offline AI insights over own records.
// No provider calls here: fallback is labelled aiGenerated:false.
export function filterRecords(rows, query = {}) {
  const q = String(query.q || query.search || "").trim().toLowerCase();
  const status = String(query.status || "").trim();
  const risk = String(query.risk || "").trim();
  return (rows || []).filter((r) => {
    if (status && r.status !== status) return false;
    if (risk && r.risk !== risk) return false;
    if (!q) return true;
    const hay = [r.reference, r.title, r.status, r.owner, r.risk, JSON.stringify(r.payload ?? {})].join(" ").toLowerCase();
    return hay.includes(q);
  });
}
function csvCell(v) { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
export function recordsToCsv(rows) {
  const cols = ["id","feature_id","reference","title","status","owner","risk","due_date","amount"];
  return [cols.join(","), ...(rows||[]).map(r => cols.map(c => csvCell(r[c])).join(","))].join("\n") + "\n";
}
export const DOMAIN_INSIGHTS = [
  {
    "id": "unrecovered-fee-value",
    "title": "Unrecovered fee & reimbursement value",
    "description": "Compare eligible vs reimbursed amounts across own marketplace records."
  },
  {
    "id": "duplicate-deduction-signal",
    "title": "Duplicate / high-risk deduction signal",
    "description": "Flag high-risk open records that may hide duplicate deductions."
  },
  {
    "id": "claim-readiness",
    "title": "Claim-package readiness",
    "description": "Surface open records missing closure, by status and due date."
  }
];
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export function buildInsights(rows) {
  const list = rows || [];
  const total = list.reduce((s,r)=>s+num(r.amount),0);
  const highRisk = list.filter(r=>["High","Critical"].includes(r.risk));
  const open = list.filter(r=>!["Approved","Closed"].includes(r.status));
  const now = Date.now();
  const overdue = open.filter(r=>r.due_date && Date.parse(r.due_date) < now);
  const hasHighRisk = highRisk.length>0, hasOverdue = overdue.length>0;
  const sectionsFor = (kind) => kind===0 ? [
      {title:"Total value in own records", detail: total},
      {title:"Record count", detail: list.length},
      {title:"Open record count", detail: open.length},
      {title:"Has high-risk records", detail: hasHighRisk},
    ] : kind===1 ? [
      {title:"High / critical-risk count", detail: highRisk.length},
      {title:"High-risk value", detail: highRisk.reduce((s,r)=>s+num(r.amount),0)},
      {title:"Has high-risk records", detail: hasHighRisk},
      {title:"References", detail: highRisk.map(r=>r.reference)},
    ] : [
      {title:"Overdue open count", detail: overdue.length},
      {title:"Has overdue records", detail: hasOverdue},
      {title:"Overdue value", detail: overdue.reduce((s,r)=>s+num(r.amount),0)},
      {title:"References", detail: overdue.map(r=>r.reference)},
    ];
  return { aiGenerated:false, source:"deterministic-fallback", provider:"offline-deterministic", label:"Deterministic fallback (not AI-generated)",
    insights: DOMAIN_INSIGHTS.map((d,i)=>({ id:d.id, title:d.title, description:d.description, aiGenerated:false, sections: sectionsFor(i) })) };
}
export function mountFeaturePack(app, { pool, auth, featureById, accountScoped=false }) {
  const scoped = accountScoped ? " AND account_id=$2" : "";
  const params = (req,id)=> accountScoped ? [id, req.user.account_id] : [id];
  app.get("/api/features/:id/records/export", auth, async (req,res,next)=>{ try{ featureById(req.params.id);
    const rows=(await pool.query(`SELECT * FROM feature_records WHERE feature_id=$1${scoped} ORDER BY updated_at DESC,id DESC`, params(req,req.params.id))).rows;
    const filtered=filterRecords(rows, req.query); const format=String(req.query.format||"json").toLowerCase();
    if(format==="csv"){ res.setHeader("Content-Type","text/csv"); res.setHeader("Content-Disposition",`attachment; filename="${req.params.id}-records.csv"`); return res.send(recordsToCsv(filtered)); }
    if(format!=="json") return res.status(422).json({error:"format must be csv or json"});
    res.setHeader("Content-Disposition",`attachment; filename="${req.params.id}-records.json"`); res.json({items:filtered, count:filtered.length});
  }catch(e){next(e);} });
  app.get("/api/features/:id/insights", auth, async (req,res,next)=>{ try{ featureById(req.params.id);
    const rows=(await pool.query(`SELECT * FROM feature_records WHERE feature_id=$1${scoped} ORDER BY updated_at DESC,id DESC`, params(req,req.params.id))).rows;
    res.json(buildInsights(filterRecords(rows, req.query)));
  }catch(e){next(e);} });
}

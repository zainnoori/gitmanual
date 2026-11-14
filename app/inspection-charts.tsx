"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Inspection } from "@/lib/inspection/types";

// Deep Inspection's charts, drawn from data the report already holds. Each one answers a question in the report and
// says so in its title; every mark has a hover tip, and the numbers behind it are in the text beside it.

const DAY = 86_400_000;
// Coordinates to a tenth of a pixel: the server and the browser can differ in the last digits of a float.
const r1 = (v: number) => Math.round(v * 10) / 10;
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const span = (days: number) =>
  days < 1 / 24 ? "minutes" : days < 1 ? `${Math.round(days * 24)} hour${Math.round(days * 24) === 1 ? "" : "s"}` : days < 14 ? `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}` : days < 60 ? `${Math.round(days / 7)} weeks` : days < 365 ? `${Math.round(days / 30)} months` : `${(days / 365).toFixed(1).replace(/\.0$/, "")} years`;

// A shared hover tip: marks report what they are, the tip follows them.
// It also measures the chart's box, so charts draw at their real width and text stays its real size.
function useTip(fallback = 640) {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: ReactNode } | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const show = (e: { currentTarget: Element }, text: ReactNode) => {
    const r = e.currentTarget.getBoundingClientRect();
    const b = box.current?.getBoundingClientRect();
    if (!b) return;
    setTip({ x: r.left + r.width / 2 - b.left, y: r.top - b.top, text });
  };
  const hide = () => setTip(null);
  const node = tip ? (
    <div className="ich-tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.text}
    </div>
  ) : null;
  return { box, show, hide, node, width };
}

// ── How it fits together: parts in layers, left to right, with the links Claude found ─────────────────────────────
const LAYERS: { name: string; re: RegExp }[] = [
  { name: "What people use", re: /front|web ?(ui|app|client)|\bui\b|client|browser|mobile|desktop|cli\b|command|extension|dashboard|website|editor|app shell/i },
  { name: "What runs it", re: /api|backend|server|service|worker|queue|job|schedul|gateway|bot|engine|core|runtime|plugin|node|pipeline|realtime|streaming/i },
  { name: "Where data lives", re: /database|\bdb\b|postgres|mysql|sqlite|mongo|redis|cache|storage|s3|search|index|vector|file ?system|blob/i },
  { name: "Outside services", re: /external|third|provider|openai|anthropic|stripe|email|smtp|oauth|\bllm\b|ai model|cloud|webhook|github|google/i },
];
function layerOf(p: { name: string; role: string }): number {
  const text = `${p.name} ${p.role}`;
  // The name decides first: "Web app" is something people use even when its role mentions the API it calls.
  for (const t of [p.name, text]) {
    const hit = [2, 3, 0, 1].find((i) => LAYERS[i].re.test(t));
    if (hit !== undefined) return hit;
  }
  return 1;
}

export function ArchitectureDiagram({ report }: { report: Inspection }) {
  const a = report.architecture!;
  const tip = useTip(900);
  const [active, setActive] = useState<string | null>(null);
  const parts = a.parts.map((p) => ({ ...p, layer: layerOf(p) }));
  const used = [...new Set(parts.map((p) => p.layer))].sort((x, y) => x - y);
  if (parts.length < 2) return null;
  const groups = used.map((l) => parts.filter((p) => p.layer === l));
  const width = tip.width;
  // Columns when there's room for them; otherwise the layers stack top to bottom, so it always fits the panel.
  const across = width >= used.length * 170 + (used.length - 1) * 56;
  const GAP = across ? Math.min(96, Math.max(48, (width - used.length * 190) / Math.max(1, used.length - 1))) : 0;
  const BW = across ? Math.min(220, (width - (used.length - 1) * GAP) / used.length) : 0;
  const H = 58;
  const pos = new Map<string, { x: number; y: number; w: number }>();
  let height = 0;
  const skips = (a.links ?? []).filter((l) => {
    const [f, t] = [parts.find((p) => p.name === l.from), parts.find((p) => p.name === l.to)];
    return across && f && t && Math.abs(used.indexOf(f.layer) - used.indexOf(t.layer)) > 1;
  });
  if (across) {
    const TOP = 30 + skips.length * 20;
    const tallest = Math.max(...groups.map((g) => g.length));
    const GY = 18;
    // Centred when the boxes don't need the whole width.
    const off = Math.max(0, (width - (used.length * BW + (used.length - 1) * GAP)) / 2);
    groups.forEach((g, ci) => {
      const colH = g.length * H + (g.length - 1) * GY;
      const y0 = TOP + (tallest * H + (tallest - 1) * GY - colH) / 2;
      g.forEach((p, ri) => pos.set(p.name, { x: r1(off + ci * (BW + GAP)), y: r1(y0 + ri * (H + GY)), w: r1(BW) }));
    });
    height = TOP + tallest * H + (tallest - 1) * GY + 8;
  } else {
    // Stacked: each layer is a row of boxes with its label above; rows wrap when a layer has many parts.
    let y = 0;
    for (const g of groups) {
      y += 22;
      const per = Math.max(1, Math.min(g.length, Math.floor((width + 12) / 150)));
      const w = (width - (per - 1) * 12) / per;
      g.forEach((p, i) => pos.set(p.name, { x: r1((i % per) * (w + 12)), y: r1(y + Math.floor(i / per) * (H + 12)), w: r1(w) }));
      y += Math.ceil(g.length / per) * (H + 12) + 18;
    }
    height = y;
  }
  const links = (a.links ?? []).filter((l) => pos.has(l.from) && pos.has(l.to));
  const route = (l: { from: string; to: string }) => {
    const [f, t] = [pos.get(l.from)!, pos.get(l.to)!];
    const lane = skips.indexOf(l as never);
    if (!across) {
      // Stacked: bottom of one box to the top of the next (or a side loop within a row).
      const down = t.y > f.y;
      const [x1, y1, x2, y2] = down ? [f.x + f.w / 2, f.y + H, t.x + t.w / 2, t.y - 3] : [f.x + f.w / 2, f.y, t.x + t.w / 2, t.y + H + 3];
      const c = (y2 - y1) / 2;
      return { d: `M${x1} ${y1} C${x1} ${y1 + c}, ${x2} ${y2 - c}, ${x2} ${y2}`, mx: r1((x1 + x2) / 2), my: r1((y1 + y2) / 2) };
    }
    if (lane >= 0) {
      const ly = 22 + lane * 20;
      const [x1, x2] = [f.x + f.w / 2, t.x + t.w / 2];
      const dir = x2 > x1 ? 1 : -1;
      return { d: `M${x1} ${f.y} C${x1} ${ly}, ${x1} ${ly}, ${x1 + 20 * dir} ${ly} L${x2 - 20 * dir} ${ly} C${x2} ${ly}, ${x2} ${ly}, ${x2} ${t.y - 3}`, mx: r1((x1 + x2) / 2), my: ly };
    }
    if (f.x === t.x) {
      const x = f.x + f.w;
      const [y1, y2] = [f.y + H / 2, t.y + H / 2];
      return { d: `M${x} ${y1} C${x + 30} ${y1}, ${x + 30} ${y2}, ${x + 3} ${y2}`, mx: r1(x + 22), my: r1((y1 + y2) / 2) };
    }
    const fwd = t.x > f.x;
    const [x1, x2] = fwd ? [f.x + f.w, t.x - 3] : [f.x, t.x + t.w + 3];
    const [y1, y2] = [f.y + H / 2, t.y + H / 2];
    const c = (x2 - x1) / 2;
    const k = 0.68;
    const bez = (p0: number, p1: number, p2: number, p3: number) => (1 - k) ** 3 * p0 + 3 * (1 - k) ** 2 * k * p1 + 3 * (1 - k) * k ** 2 * p2 + k ** 3 * p3;
    return { d: `M${x1} ${y1} C${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`, mx: r1(bez(x1, x1 + c, x2 - c, x2)), my: r1(bez(y1, y1, y2, y2)) };
  };
  const clip = (s: string, w: number, px: number) => {
    const n = Math.max(6, Math.floor((w - 24) / px));
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  };
  // Hovering a part lights up its links and the parts it talks to; the rest fades back.
  const near = (name: string) => !active || name === active || links.some((l) => (l.from === active && l.to === name) || (l.to === active && l.from === name));
  return (
    <div className="ich-arch" ref={tip.box}>
      <svg viewBox={`-4 -4 ${width + 8} ${height + 8}`} width={width} height={height} role="img" aria-label={`${parts.length} parts${links.length ? ` and ${links.length} links` : ""}: ${parts.map((p) => p.name).join(", ")}`}>
        <defs>
          <marker id="ich-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--pencil)" />
          </marker>
        </defs>
        {groups.map((g, gi) => {
          const first = pos.get(g[0].name)!;
          return (
            <text key={used[gi]} x={across ? first.x : 0} y={across ? 10 : first.y - 8} className="ich-arch-layer">
              {LAYERS[used[gi]].name.toUpperCase()}
            </text>
          );
        })}
        {links.map((l) => {
          const p = route(l);
          const on = !active || l.from === active || l.to === active;
          return (
            <g key={`${l.from}>${l.to}`} className={`ich-link${on ? "" : " dim"}${active && on ? " hot" : ""}`}>
              <path d={p.d} fill="none" strokeWidth="1.5" markerEnd="url(#ich-arrow)" />
              {l.label && across && (
                <g transform={`translate(${p.mx} ${p.my})`}>
                  <rect x={-(l.label.length * 3.3 + 7)} y={-9} width={l.label.length * 6.6 + 14} height={18} rx={9} />
                  <text textAnchor="middle" y={4} className="ich-link-label">
                    {l.label}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {parts.map((p) => {
          const { x, y, w } = pos.get(p.name)!;
          const enter = (e: { currentTarget: Element }) => {
            setActive(p.name);
            const out = links.filter((l) => l.from === p.name).map((l) => `${l.to}${l.label ? ` (${l.label})` : ""}`);
            tip.show(e, <><b>{p.name}</b> {p.role}{out.length ? <><br />Talks to {out.join(", ")}</> : null}</>);
          };
          const leave = () => {
            setActive(null);
            tip.hide();
          };
          return (
            <g key={p.name} className={`ich-part${near(p.name) ? "" : " dim"}`} tabIndex={0} onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave}>
              <rect x={x} y={y} width={w} height={H} rx={12} />
              <text x={x + 12} y={y + 24} className="ich-part-name">
                {clip(p.name, w, 8.4)}
              </text>
              <text x={x + 12} y={y + 43} className="ich-part-path">
                {clip(p.paths[0] ?? "", w, 6.7)}
              </text>
            </g>
          );
        })}
      </svg>
      {tip.node}
    </div>
  );
}

// ── Who answers issues: one dot per issue, by how long until the first reply ───────────────────────────────────────
export function RepliesChart({ report }: { report: Inspection }) {
  const tip = useTip();
  const now = report.scannedAt;
  const issues = (report.facts.threads?.issues ?? []).filter((t) => !t.bot && now - Date.parse(t.createdAt) >= 2 * DAY);
  if (issues.length < 5) return null;
  const known = issues.some((t) => t.maintainerReply !== undefined);
  const rows = [
    { key: "m", label: "A maintainer replied", fill: "var(--ink)" },
    { key: "u", label: "Only other users", fill: "var(--steel)" },
    { key: "n", label: "No reply yet", fill: "var(--no)" },
  ] as const;
  const dots = issues.map((t) => {
    const created = Date.parse(t.createdAt);
    const maint = t.maintainerReply ?? (t.firstReply?.maintainer ? t.firstReply.at : null);
    const row = maint ? "m" : t.firstReply ? "u" : "n";
    const at = maint ?? t.firstReply?.at ?? null;
    const days = at ? Math.max(1 / 48, (Date.parse(at) - created) / DAY) : (now - created) / DAY;
    return { row, days, created, closed: Boolean(t.closedAt) };
  });
  // Log scale from 30 minutes to 6 months: replies cluster in hours, the slow ones stretch out.
  const MIN = 1 / 48;
  const MAX = 180;
  const W = tip.width;
  const narrow = W < 560;
  const L = narrow ? 140 : 170;
  const RH = 44;
  const x = (d: number) => r1(L + 14 + ((Math.log(Math.min(Math.max(d, MIN), MAX)) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN))) * (W - L - 26));
  const ticks: [number, string][] = [[1 / 24, "1h"], [1, "1d"], [7, "1w"], [30, "1mo"], [180, "6mo"]];
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const height = rows.length * RH + 30;
  return (
    <section className="insp-card insp-wide" aria-labelledby="ich-replies">
      <h2 id="ich-replies">Who answers issues, and how fast</h2>
      <div className="ich-box" ref={tip.box}>
        <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} role="img" aria-label={rows.map((r) => `${dots.filter((d) => d.row === r.key).length} ${r.label.toLowerCase()}`).join(", ")}>
          {ticks.map(([d, label]) => (
            <g key={label}>
              <line x1={x(d)} x2={x(d)} y1={4} y2={rows.length * RH + 4} stroke="var(--line)" />
              <text x={x(d)} y={rows.length * RH + 20} textAnchor="middle" className="ich-axis">
                {label}
              </text>
            </g>
          ))}
          {rows.map((r, ri) => {
            const mine = dots.filter((d) => d.row === r.key);
            const m = median(mine.map((d) => d.days));
            return (
              <g key={r.key}>
                <text x={0} y={ri * RH + RH / 2 + 2} className="ich-row-label">
                  {r.label}
                </text>
                <text x={0} y={ri * RH + RH / 2 + 15} className="ich-row-sub">
                  {mine.length}
                  {narrow ? "" : ` ${mine.length === 1 ? "issue" : "issues"}`}
                  {m !== null && r.key !== "n" ? ` · median ${span(m)}` : r.key === "n" && mine.length ? (narrow ? "" : " · open this long") : ""}
                </text>
                {mine.map((d, i) => (
                  <circle
                    key={i}
                    cx={x(d.days)}
                    cy={ri * RH + RH / 2 + ((i % 3) - 1) * 6}
                    r={5}
                    fill={r.key === "n" ? "var(--sheet)" : r.fill}
                    stroke={r.key === "n" ? r.fill : "var(--sheet)"}
                    strokeWidth={2}
                    onMouseEnter={(e) => tip.show(e, `Opened ${fmtDate(d.created)} · ${r.key === "n" ? `no reply after ${span(d.days)}${d.closed ? " (closed)" : ""}` : `first reply after ${span(d.days)}`}`)}
                    onMouseLeave={tip.hide}
                  />
                ))}
              </g>
            );
          })}
        </svg>
        {tip.node}
      </div>
      <p className="note">
        The latest {issues.length} issues, opened since {fmtDate(Math.min(...dots.map((d) => d.created)))}; time to the first reply from someone other than the author, bots left out.
        {known ? " Maintainers are owners, members and collaborators; GitHub hides some memberships, so this can undercount them." : ""}
      </p>
    </section>
  );
}

// ── Releases over time, and the gap since the last one ───────────────────────────────────────────────────────────
export function ReleaseTimeline({ report }: { report: Inspection }) {
  const tip = useTip();
  const rel = (report.facts.releases ?? []).map((r) => ({ ...r, t: Date.parse(r.date) })).filter((r) => !Number.isNaN(r.t));
  if (rel.length < 2) return null;
  const now = report.scannedAt;
  const first = Math.min(...rel.map((r) => r.t));
  const W = tip.width;
  const x = (t: number) => r1(8 + ((t - first) / Math.max(1, now - first)) * (W - 16));
  const stable = rel.filter((r) => !r.prerelease).sort((a, b) => b.t - a.t);
  const last = stable[0] ?? rel[0];
  const gap = (now - last.t) / DAY;
  // Year ticks for long histories, quarter ticks for short ones.
  const years: { t: number; label: string }[] = [];
  const short = now - first < 2 * 365 * DAY;
  for (let d = new Date(Date.UTC(new Date(first).getUTCFullYear(), 0, 1)); d.getTime() <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (short ? 3 : 12), 1)))
    if (d.getTime() > first) years.push({ t: d.getTime(), label: short ? d.toLocaleDateString("en-US", { month: "short", year: d.getUTCMonth() === 0 ? "numeric" : undefined, timeZone: "UTC" }) : String(d.getUTCFullYear()) });
  return (
    <section className="insp-card insp-wide" aria-labelledby="ich-rel">
      <h2 id="ich-rel">Releases over time</h2>
      <div className="ich-box" ref={tip.box}>
        <svg viewBox={`0 0 ${W} 86`} width={W} height={86} role="img" aria-label={`${rel.length} releases from ${fmtDate(first)}; the latest stable release ${span(gap)} ago`}>
          <line x1={8} x2={W - 8} y1={40} y2={40} stroke="var(--line-strong)" />
          {years.map((y) => (
            <g key={y.t}>
              <line x1={x(y.t)} x2={x(y.t)} y1={34} y2={46} stroke="var(--line-strong)" />
              <text x={x(y.t)} y={64} textAnchor="middle" className="ich-axis">
                {y.label}
              </text>
            </g>
          ))}
          {gap > 90 && (
            <g>
              <rect x={x(last.t)} y={30} width={Math.max(2, x(now) - x(last.t))} height={20} fill="color-mix(in srgb, var(--maybe) 30%, transparent)" rx={4} />
              <text x={(x(last.t) + x(now)) / 2} y={22} textAnchor="middle" className="ich-gap">
                {span(gap)} since the last release
              </text>
            </g>
          )}
          {rel.map((r) => (
            <circle
              key={r.tag}
              cx={x(r.t)}
              cy={40}
              r={4}
              fill={r.prerelease ? "var(--sheet)" : "var(--ink)"}
              stroke={r.prerelease ? "var(--ink)" : "var(--sheet)"}
              strokeWidth={2}
              onMouseEnter={(e) => tip.show(e, `${r.tag} · ${fmtDate(r.t)}${r.prerelease ? " · pre-release" : ""}`)}
              onMouseLeave={tip.hide}
            />
          ))}
          <text x={W - 8} y={64} textAnchor="end" className="ich-axis">
            today
          </text>
        </svg>
        {tip.node}
      </div>
      <p className="note">
        {rel.length} latest releases ({stable.length} stable, filled; {rel.length - stable.length} pre-releases, hollow). Latest stable: {last.tag}, {fmtDate(last.t)}.
      </p>
    </section>
  );
}

// ── Continuity: the top contributor's share of all commits against the latest 100 ─────────────────────────────────
export function ContinuityBars({ report }: { report: Inspection }) {
  const people = (report.facts.contributors ?? []).filter((c) => c.commits > 0);
  const recent = (report.facts.recentCommits ?? []).filter((c) => c.login && !/\[bot\]$/.test(c.login));
  if (!people.length || recent.length < 20) return null;
  const top = people[0];
  const total = people.reduce((s, c) => s + c.commits, 0);
  const allShare = Math.round((top.commits / total) * 100);
  const recentShare = Math.round((recent.filter((c) => c.login === top.login).length / recent.length) * 100);
  const others = new Set(recent.map((c) => c.login)).size - (recent.some((c) => c.login === top.login) ? 1 : 0);
  const Bar = ({ label, share }: { label: string; share: number }) => (
    <li>
      <span className="ich-cont-label">{label}</span>
      <span className="ich-cont-bar" role="img" aria-label={`@${top.login} ${share}%, everyone else ${100 - share}%`}>
        {share > 0 && <i className="top" style={{ width: `${share}%` }} />}
        {share < 100 && <i className="rest" style={{ width: `${100 - share}%` }} />}
      </span>
      <b className="num">{share}%</b>
    </li>
  );
  return (
    <div className="ich-cont">
      <p className="ich-cont-key">
        <i className="top" /> @{top.login} <i className="rest" /> everyone else
      </p>
      <ul>
        <Bar label="All commits" share={allShare} />
        <Bar label={`Latest ${recent.length}`} share={recentShare} />
      </ul>
      <p className="note">
        {others} other {others === 1 ? "person" : "people"} wrote commits among the latest {recent.length}.
      </p>
    </div>
  );
}

// ── Stars over time: the total, how fast it grows, and the milestones on the way ──────────────────────────────────
type Range = "all" | "2y" | "1y" | "6m";
const RANGES: { id: Range; label: string; days: number }[] = [
  { id: "all", label: "All", days: Infinity },
  { id: "2y", label: "2 years", days: 730 },
  { id: "1y", label: "1 year", days: 365 },
  { id: "6m", label: "6 months", days: 182 },
];
const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));
const month = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).replace(" ", " '");

export function StarHistory({ report }: { report: Inspection }) {
  const tip = useTip();
  const [range, setRange] = useState<Range>("all");
  const [hover, setHover] = useState<number | null>(null);
  const h = report.facts.starHistory;
  const total = report.facts.repo.stars;
  // Weeks from GitHub's weekly counts, scaled so the running total ends at today's count (unstars aren't in them).
  const weeks = (() => {
    if (h?.weekly?.gains.length) {
      const t0 = Date.parse(h.weekly.start);
      const sum = h.weekly.gains.reduce((a, b) => a + b, 0) || 1;
      let run = 0;
      return h.weekly.gains.map((g, i) => ({ t: t0 + i * 7 * DAY, gain: g, total: Math.round(((run += g) * total) / sum) }));
    }
    // Older reports: the sampled points, each step one "week".
    const pts = (h?.points ?? []).map((p) => ({ t: Date.parse(p.date), total: p.stars }));
    return pts.map((p, i) => ({ ...p, gain: i ? Math.max(0, p.total - pts[i - 1].total) : p.total }));
  })();
  if (weeks.length < 3) return null;
  const now = report.scannedAt;
  const days = RANGES.find((r) => r.id === range)!.days;
  const view = weeks.filter((w) => now - w.t <= days * DAY);
  const shown = view.length >= 3 ? view : weeks;
  // Per week for short spans, per month for long ones, so the bars stay readable.
  const monthly = shown.length > 110;
  const bars: { t: number; gain: number }[] = [];
  for (const w of shown) {
    const key = monthly ? Date.UTC(new Date(w.t).getUTCFullYear(), new Date(w.t).getUTCMonth(), 1) : w.t;
    const last = bars[bars.length - 1];
    if (last && last.t === key) last.gain += w.gain;
    else bars.push({ t: key, gain: w.gain });
  }
  const recent = weeks.filter((w) => now - w.t <= 30 * DAY).reduce((a, w) => a + w.gain, 0);
  const best = weeks.reduce((a, w) => (w.gain > a.gain ? w : a), weeks[0]);

  const W = tip.width;
  const L = 46;
  const TOP = 18;
  const LINE_H = 150;
  const BAR_TOP = TOP + LINE_H + 26;
  const BAR_H = 54;
  const HT = BAR_TOP + BAR_H + 22;
  const [t0, t1] = [shown[0].t, Math.max(shown[shown.length - 1].t, now - 3 * DAY)];
  const x = (t: number) => r1(L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - 10));
  const lo = range === "all" ? 0 : shown[0].total;
  const hi = Math.max(lo + 1, shown[shown.length - 1].total);
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000].find((s) => (hi - lo) / s <= 4) ?? 500_000;
  const yMin = Math.floor(lo / step) * step;
  const yMax = Math.ceil(hi / step) * step;
  const y = (v: number) => r1(TOP + LINE_H - ((v - yMin) / Math.max(1, yMax - yMin)) * LINE_H);
  const line = shown.map((w, i) => `${i ? "L" : "M"}${x(w.t)} ${y(w.total)}`).join(" ");
  const maxBar = Math.max(1, ...bars.map((b) => b.gain));
  const bw = Math.max(1.5, Math.min(14, (W - L - 10) / bars.length - 2));
  // Milestones crossed in view, kept apart so their labels never collide.
  const marks: { t: number; v: number }[] = [];
  for (const m of [100, 500, 1000, 5000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000]) {
    const at = shown.find((w) => w.total >= m);
    if (at && m > yMin + (yMax - yMin) * 0.05 && (!marks.length || x(at.t) - x(marks[marks.length - 1].t) > 64)) marks.push({ t: at.t, v: m });
  }
  const years: number[] = [];
  for (let yr = new Date(t0).getUTCFullYear() + 1; yr <= new Date(t1).getUTCFullYear(); yr++) years.push(Date.UTC(yr, 0, 1));
  const ticks = years.length >= 2 ? years.map((t) => ({ t, label: String(new Date(t).getUTCFullYear()) })) : [0.25, 0.5, 0.75].map((f) => ({ t: t0 + (t1 - t0) * f, label: month(t0 + (t1 - t0) * f) }));
  const hw = hover !== null ? shown[hover] : null;
  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - box.left) / box.width) * (t1 - t0);
    let best = 0;
    shown.forEach((w, i) => {
      if (Math.abs(w.t - t) < Math.abs(shown[best].t - t)) best = i;
    });
    setHover(best);
  };
  return (
    <section className="insp-card insp-wide ich-stars" aria-labelledby="ich-stars">
      <div className="ich-stars-head">
        <h2 id="ich-stars">Stars over time</h2>
        <div className="seg ich-range" role="radiogroup" aria-label="Time range">
          {RANGES.filter((r) => r.id === "all" || weeks.some((w) => now - w.t > r.days * DAY)).map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={range === r.id} className={range === r.id ? "on" : ""} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <ul className="ich-stats">
        <li>
          <b className="num">{total.toLocaleString("en-US")}</b>
          <span>stars today</span>
        </li>
        <li>
          <b className="num">+{recent.toLocaleString("en-US")}</b>
          <span>in the last 30 days</span>
        </li>
        <li>
          <b className="num">+{best.gain.toLocaleString("en-US")}</b>
          <span>best week, {month(best.t)}</span>
        </li>
        <li>
          <b className="num">{month(weeks[0].t)}</b>
          <span>first stars</span>
        </li>
      </ul>
      <div className="ich-box" ref={tip.box}>
        <svg viewBox={`0 0 ${W} ${HT}`} width={W} height={HT} role="img" aria-label={`${total.toLocaleString("en-US")} stars; ${recent.toLocaleString("en-US")} in the last 30 days; best week ${best.gain.toLocaleString("en-US")} stars in ${month(best.t)}`}>
          {[yMin, (yMin + yMax) / 2, yMax].map((v) => (
            <g key={v}>
              <line x1={L} x2={W - 10} y1={y(v)} y2={y(v)} stroke="var(--line)" />
              <text x={L - 8} y={y(v) + 4} textAnchor="end" className="ich-axis">
                {compact(v)}
              </text>
            </g>
          ))}
          <path d={`${line} L${x(shown[shown.length - 1].t)} ${y(yMin)} L${x(t0)} ${y(yMin)} Z`} className="ich-stars-area" />
          <path d={line} className="ich-stars-line" />
          {marks.map((m) => (
            <g key={m.v} className="ich-mark">
              <line x1={x(m.t)} x2={x(m.t)} y1={y(m.v)} y2={y(m.v) - 22} />
              <circle cx={x(m.t)} cy={y(m.v)} r={4} />
              <text x={x(m.t) + 5} y={y(m.v) - 14}>{compact(m.v)}</text>
              <text x={x(m.t) + 5} y={y(m.v) - 3} className="sub">
                {month(m.t)}
              </text>
            </g>
          ))}
          <circle cx={x(shown[shown.length - 1].t)} cy={y(shown[shown.length - 1].total)} r={4.5} className="ich-stars-end" />
          <text x={L} y={BAR_TOP - 8} className="ich-axis">
            NEW STARS PER {monthly ? "MONTH" : "WEEK"}
          </text>
          {bars.map((b) => {
            const bh = Math.max(b.gain ? 1.5 : 0, (b.gain / maxBar) * BAR_H);
            return <rect key={b.t} x={x(b.t) - bw / 2} y={BAR_TOP + BAR_H - bh} width={bw} height={bh} rx={Math.min(2, bw / 2)} className={hw && (monthly ? new Date(hw.t).getUTCMonth() === new Date(b.t).getUTCMonth() && new Date(hw.t).getUTCFullYear() === new Date(b.t).getUTCFullYear() : hw.t === b.t) ? "ich-bar on" : "ich-bar"} />;
          })}
          <line x1={L} x2={W - 10} y1={BAR_TOP + BAR_H} y2={BAR_TOP + BAR_H} stroke="var(--line-strong)" />
          {ticks.map((tk) => (
            <text key={tk.t} x={x(tk.t)} y={HT - 4} textAnchor="middle" className="ich-axis">
              {tk.label}
            </text>
          ))}
          {hw && (
            <g className="ich-cross">
              <line x1={x(hw.t)} x2={x(hw.t)} y1={TOP} y2={BAR_TOP + BAR_H} />
              <circle cx={x(hw.t)} cy={y(hw.total)} r={4.5} />
            </g>
          )}
          <rect
            x={L}
            y={0}
            width={W - L - 10}
            height={BAR_TOP + BAR_H}
            fill="transparent"
            onPointerMove={(e) => {
              move(e);
            }}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hw && (
          <div className="ich-tip" style={{ left: x(hw.t), top: y(hw.total) }}>
            <b>{hw.total.toLocaleString("en-US")} stars</b> · week of {fmtDate(hw.t)}, +{hw.gain.toLocaleString("en-US")}
          </div>
        )}
      </div>
      <p className="note">From GitHub&apos;s weekly star counts. Stars show interest, not use, and can be bought.</p>
    </section>
  );
}

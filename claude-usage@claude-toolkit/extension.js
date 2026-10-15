// Claude & Codex Usage — GNOME Shell top-bar indicators for subscription limits.
//
// Panel (right of the clock):  ✳  ◔ 23%  ▮▮▮▯▯▯▯ 41%     >_  ◔ 12%  ▮▯▯▯▯▯▯ 8%
//   ring  = short rolling window (5 hours; a clock face: it's time-boxed)
//   7 bars = weekly window (one bar ≈ one day's even share of the week)
//
// Claude: the endpoint Claude Code's /usage uses, authenticated with the OAuth token
// Claude Code keeps in ~/.claude/.credentials.json. The file is only read, never
// written: when the token expires, using Claude Code refreshes it and the indicator
// picks the new one up automatically.
//
// Codex: `account/rateLimits/read` on a short-lived `codex app-server` (JSON-RPC over
// stdio), so the Codex CLI itself handles login and token refresh.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
const CLAUDE_CREDENTIALS = '.credentials.json';
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage-indicator']);

const POLL_SECONDS = 300;
const MAX_BACKOFF_SECONDS = 1800;
const MIN_GAP_SECONDS = 20;
const STALE_ON_OPEN_SECONDS = 60;
const STALE_SECONDS = 15 * 60;
const CODEX_TIMEOUT_SECONDS = 45;
const SESSION_SECONDS = 5 * 3600;
const WEEK_SECONDS = 7 * 86400;

// [r, g, b] in 0..1
const C = {
    session: [0.38, 0.82, 0.71], // mint        #61D1B5
    weekly: [0.55, 0.64, 0.98], // periwinkle  #8CA3FA
    warn: [0.97, 0.73, 0.30], // amber       #F7BA4D
    crit: [0.96, 0.39, 0.37], // coral red   #F5635E
    spark: [0.85, 0.47, 0.34], // Claude clay #D97757
};

const PROVIDERS = {
    claude: {
        key: 'claude',
        name: 'Claude Usage',
        title: 'Claude 用量',
        icon: 'spark',
        usageUrl: 'https://claude.ai/settings/usage',
        errors: {
            nocreds: '未找到 Claude Code 登录信息，请先在终端运行 claude 并登录',
            expired: '登录令牌已过期，使用一次 Claude Code 后会自动恢复',
        },
    },
    codex: {
        key: 'codex',
        name: 'Codex Usage',
        title: 'Codex 用量',
        icon: 'prompt',
        usageUrl: 'https://chatgpt.com/codex/settings/usage',
        errors: {
            nocli: '未找到 codex 命令，请确认已安装 Codex CLI',
            nocreds: 'Codex 未登录，请在终端运行 codex login',
            timeout: 'Codex 响应超时，稍后自动重试',
            rpc: 'Codex 返回错误',
        },
    },
};

const COMMON_ERRORS = {
    ratelimit: '请求过于频繁，稍后自动重试',
    network: '网络连接失败，稍后自动重试',
    parse: '无法解析返回的用量数据',
    http: '服务器返回错误',
};

const CLAUDE_MODEL_LIMITS = [
    ['seven_day_opus', 'Opus'],
    ['seven_day_sonnet', 'Sonnet'],
];

const CODEX_PLANS = {
    free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max',
    team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
    edu_plus: 'Edu Plus', edu_pro: 'Edu Pro',
};

const WEEKDAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/* ---------- helpers ---------- */

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function levelColor(base, pct) {
    if (pct >= 90)
        return C.crit;
    if (pct >= 75)
        return C.warn;
    return base;
}

function cssColor([r, g, b]) {
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function secondsUntil(dt) {
    return dt.difference(GLib.DateTime.new_now_utc()) / 1e6;
}

// Fraction of the window's time that has already elapsed, or null if no window is running.
function paceOf(win) {
    if (!win?.resetsAt || !win.duration)
        return null;
    return clamp(1 - secondsUntil(win.resetsAt) / win.duration, 0, 1);
}

function windowCaption(seconds) {
    if (!seconds)
        return '';
    const hours = seconds / 3600;
    return hours < 24 ? `${Math.round(hours)} 小时窗口` : `${Math.round(hours / 24)} 天窗口`;
}

function longWindowTitle(seconds) {
    const days = (seconds ?? WEEK_SECONDS) / 86400;
    return days >= 6 && days <= 8 ? '本周' : `${Math.round(days)} 天周期`;
}

/* ---------- Claude data ---------- */

function claudeWindow(raw, duration) {
    if (!raw || typeof raw.utilization !== 'number')
        return null;
    const resetsAt = raw.resets_at ? GLib.DateTime.new_from_iso8601(raw.resets_at, null) : null;
    return {pct: Math.max(0, raw.utilization), resetsAt, duration};
}

function parseClaude(raw) {
    const session = claudeWindow(raw?.five_hour, SESSION_SECONDS);
    const week = claudeWindow(raw?.seven_day, WEEK_SECONDS);
    if (!session && !week)
        return null;
    const models = [];
    for (const [key, name] of CLAUDE_MODEL_LIMITS) {
        const win = claudeWindow(raw[key], WEEK_SECONDS);
        if (win)
            models.push({label: `${name} 每周`, ...win});
    }
    return {session, week, models, notes: [], blocked: false};
}

function readClaudeCredentials() {
    try {
        const path = GLib.build_filenamev([CLAUDE_DIR, CLAUDE_CREDENTIALS]);
        const [, bytes] = GLib.file_get_contents(path);
        const oauth = JSON.parse(new TextDecoder().decode(bytes))?.claudeAiOauth;
        if (!oauth?.accessToken)
            return {};
        const expired = typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now();
        return {token: expired ? null : oauth.accessToken, expired, plan: claudePlan(oauth)};
    } catch {
        return {};
    }
}

function claudePlan(oauth) {
    const tier = /max_(\d+x)/i.exec(oauth.rateLimitTier ?? '');
    if (tier)
        return `Max ${tier[1]}`;
    const type = oauth.subscriptionType;
    return type ? type[0].toUpperCase() + type.slice(1) : null;
}

/* ---------- Codex data ---------- */

function codexWindow(raw, fallbackDuration) {
    if (!raw || typeof raw.usedPercent !== 'number')
        return null;
    const duration = raw.windowDurationMins ? raw.windowDurationMins * 60 : fallbackDuration;
    const resetsAt = typeof raw.resetsAt === 'number'
        ? GLib.DateTime.new_from_unix_utc(Math.floor(raw.resetsAt)) : null;
    return {pct: Math.max(0, raw.usedPercent), resetsAt, duration};
}

// Codex reports up to two windows; which one is the 5-hour and which the weekly
// depends on the plan, so sort them by their duration rather than their position.
function codexWindows(snap) {
    let session = null, week = null;
    const wins = [codexWindow(snap?.primary, SESSION_SECONDS), codexWindow(snap?.secondary, WEEK_SECONDS)];
    for (const win of wins) {
        if (!win)
            continue;
        if (win.duration <= 86400)
            session ??= win;
        else
            week ??= win;
    }
    return {session, week};
}

function parseCodex(raw) {
    const snap = raw?.rateLimits;
    const {session, week} = codexWindows(snap);
    if (!session && !week)
        return null;

    const models = [];
    for (const [id, other] of Object.entries(raw.rateLimitsByLimitId ?? {})) {
        if (!other || id === snap.limitId)
            continue;
        const name = other.limitName ?? other.normalModelSlug ?? id;
        const wins = codexWindows(other);
        if (wins.session)
            models.push({label: `${name} 5 小时`, ...wins.session});
        if (wins.week)
            models.push({label: `${name} 每周`, ...wins.week});
    }

    const notes = [];
    const resets = Number(raw.rateLimitResetCredits?.availableCount ?? 0);
    if (resets > 0)
        notes.push(`可用额度重置 ${resets} 次`);
    if (snap.credits?.unlimited)
        notes.push('Credits 不限量');
    else if (snap.credits?.hasCredits && snap.credits.balance)
        notes.push(`Credits 余额 ${snap.credits.balance}`);

    const type = snap.planType;
    const plan = type && type !== 'unknown'
        ? CODEX_PLANS[type] ?? type[0].toUpperCase() + type.slice(1).replace(/_/g, ' ')
        : null;
    const blocked = raw.ordinaryUsageAllowed === false || !!snap.rateLimitReachedType;
    return {session, week, models, notes, blocked, plan};
}

// GNOME Shell's PATH usually lacks per-user installs (nvm, ~/.local/bin, …) but may
// contain /snap/bin. Prefer per-user installs — what an interactive terminal runs —
// over system-wide ones, and snap last: a snap codex is often an older build with
// its own, separate login.
function findCodex() {
    const home = GLib.get_home_dir();
    const candidates = [];
    try {
        const nvm = Gio.File.new_for_path(GLib.build_filenamev([home, '.nvm', 'versions', 'node']));
        const iter = nvm.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const versions = [];
        for (let info; (info = iter.next_file(null));)
            versions.push(info.get_name());
        iter.close(null);
        versions.sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
        for (const v of versions)
            candidates.push(GLib.build_filenamev([nvm.get_path(), v, 'bin', 'codex']));
    } catch {}
    for (const dir of ['.local/bin', '.npm-global/bin', '.volta/bin', '.bun/bin', '.cargo/bin'])
        candidates.push(GLib.build_filenamev([home, dir, 'codex']));
    const inPath = GLib.find_program_in_path('codex');
    if (inPath && !inPath.startsWith('/snap/'))
        candidates.push(inPath);
    candidates.push('/usr/local/bin/codex', '/usr/bin/codex', '/snap/bin/codex');
    return candidates.find(p => p && GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

/* ---------- formatting ---------- */

function fmtDuration(sec) {
    const m = Math.max(1, Math.ceil(sec / 60));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d > 0)
        return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
    if (h > 0)
        return mm > 0 ? `${h} 小时 ${mm} 分` : `${h} 小时`;
    return `${mm} 分钟`;
}

function localDayIndex(dt) {
    return Math.floor((dt.to_unix() + dt.get_utc_offset() / 1e6) / 86400);
}

function fmtWhen(dt) {
    const local = dt.to_local();
    const hm = local.format('%H:%M');
    const days = localDayIndex(local) - localDayIndex(GLib.DateTime.new_now_local());
    if (days === 0)
        return `今天 ${hm}`;
    if (days === 1)
        return `明天 ${hm}`;
    if (days > 0 && days < 7)
        return `${WEEKDAYS[local.get_day_of_week()]} ${hm}`;
    return local.format('%m-%d %H:%M');
}

function resetText(win) {
    if (!win?.resetsAt)
        return '尚未开始计时';
    const left = secondsUntil(win.resetsAt);
    if (left <= 0)
        return '正在重置…';
    return `${fmtDuration(left)}后重置 · ${fmtWhen(win.resetsAt)}`;
}

function paceText(win) {
    const pace = paceOf(win);
    if (pace === null)
        return '用量 0%，下次使用时开始计时';
    const diff = win.pct - pace * 100;
    const verdict = diff > 10 ? '消耗偏快' : diff < -10 ? '余量充足' : '节奏平稳';
    return `时间已过 ${Math.round(pace * 100)}% · ${verdict}`;
}

function dailyBudgetText(win) {
    const left = Math.max(0, 100 - win.pct);
    if (!win.resetsAt)
        return `剩余 ${Math.round(left)}%`;
    const daysLeft = Math.max(1, secondsUntil(win.resetsAt) / 86400);
    return `剩余 ${Math.round(left)}% · 平均每天可用 ${(left / daysLeft).toFixed(1)}%`;
}

/* ---------- drawing ---------- */

function rgba(cr, [r, g, b], a = 1) {
    cr.setSourceRGBA(r, g, b, a);
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

const TRACK_ALPHA = 0.2;

const DRAW = {
    // Claude-style starburst
    spark(cr, w, h) {
        const lens = [1, 0.74, 0.94, 0.7, 0.98, 0.78, 0.9, 0.72, 0.96, 0.76];
        const R = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
        const lw = Math.max(1.1, R * 0.19);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(lw);
        rgba(cr, C.spark);
        lens.forEach((len, i) => {
            const a = (i / lens.length) * 2 * Math.PI - Math.PI / 2 + 0.13;
            const r0 = R * 0.16, r1 = R * len - lw / 2;
            cr.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
            cr.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
        });
        cr.stroke();
    },

    // Codex: a terminal prompt ">_" in the text colour
    prompt(cr, w, h, g, fg) {
        const s = Math.min(w, h), ox = (w - s) / 2, oy = (h - s) / 2;
        const lw = Math.max(1.4, s * 0.15);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineWidth(lw);
        rgba(cr, fg, 0.95);
        cr.moveTo(ox + s * 0.14, oy + s * 0.24);
        cr.lineTo(ox + s * 0.46, oy + s * 0.5);
        cr.lineTo(ox + s * 0.14, oy + s * 0.76);
        cr.moveTo(ox + s * 0.58, oy + s * 0.78);
        cr.lineTo(ox + s * 0.9, oy + s * 0.78);
        cr.stroke();
    },

    // Short window: ring filled clockwise from 12 o'clock; optional dot marks elapsed time.
    ring(cr, w, h, g, fg) {
        const s = Math.min(w, h), cx = w / 2, cy = h / 2;
        const lw = Math.max(2, s * (g.thin ? 0.1 : 0.17));
        const r = s / 2 - lw / 2;
        const top = -Math.PI / 2;
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(lw);
        rgba(cr, fg, TRACK_ALPHA);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();
        if (g.frac > 0.002) {
            rgba(cr, g.color, g.dim ? 0.55 : 1);
            cr.arc(cx, cy, r, top, top + 2 * Math.PI * g.frac);
            cr.stroke();
        }
        if (g.showPace && g.pace !== null) {
            const a = top + 2 * Math.PI * g.pace;
            const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
            rgba(cr, fg, 0.95);
            cr.arc(px, py, lw * 0.62, 0, 2 * Math.PI);
            cr.fill();
            rgba(cr, g.color, 1);
            cr.arc(px, py, lw * 0.3, 0, 2 * Math.PI);
            cr.fill();
        }
    },

    // Weekly (panel): 7 vertical pills, filled left→right, partial pill fills bottom→top.
    pills(cr, w, h, g, fg) {
        const n = 7, gap = Math.max(1.5, w * 0.06);
        const pw = (w - gap * (n - 1)) / n;
        const filled = g.frac * n;
        for (let i = 0; i < n; i++) {
            const x = i * (pw + gap);
            roundedRect(cr, x, 0, pw, h, pw / 2);
            rgba(cr, fg, TRACK_ALPHA);
            cr.fill();
            const f = clamp(filled - i, 0, 1);
            if (f > 0) {
                cr.save();
                roundedRect(cr, x, 0, pw, h, pw / 2);
                cr.clip();
                cr.rectangle(x, h * (1 - f), pw, h * f);
                rgba(cr, g.color, g.dim ? 0.55 : 1);
                cr.fill();
                cr.restore();
            }
        }
    },

    // Weekly (popup): 7 cells — one per day's even share — plus a ▾ marker for elapsed time.
    cells(cr, w, h, g, fg) {
        const n = 7, gap = 4, top = 7;
        const bh = h - top;
        const cw = (w - gap * (n - 1)) / n;
        const filled = g.frac * n;
        for (let i = 0; i < n; i++) {
            const x = i * (cw + gap);
            roundedRect(cr, x, top, cw, bh, 4);
            rgba(cr, fg, TRACK_ALPHA * 0.8);
            cr.fill();
            const f = clamp(filled - i, 0, 1);
            if (f > 0) {
                cr.save();
                roundedRect(cr, x, top, cw, bh, 4);
                cr.clip();
                cr.rectangle(x, top, cw * f, bh);
                rgba(cr, g.color, g.dim ? 0.55 : 1);
                cr.fill();
                cr.restore();
            }
        }
        if (g.pace !== null) {
            // map elapsed time onto the cells (skipping gaps) so day boundaries line up
            const day = g.pace * n;
            const i = Math.min(n - 1, Math.floor(day));
            const x = clamp(i * (cw + gap) + (day - i) * cw, 1, w - 1);
            rgba(cr, fg, 0.85);
            cr.moveTo(x - 4, 0);
            cr.lineTo(x + 4, 0);
            cr.lineTo(x, 5);
            cr.closePath();
            cr.fill();
            cr.setLineWidth(1.5);
            rgba(cr, fg, 0.55);
            cr.moveTo(x, top);
            cr.lineTo(x, h);
            cr.stroke();
        }
    },

    // Thin horizontal bar for per-model limits.
    bar(cr, w, h, g, fg) {
        roundedRect(cr, 0, 0, w, h, h / 2);
        rgba(cr, fg, TRACK_ALPHA * 0.8);
        cr.fill();
        if (g.frac > 0.002) {
            roundedRect(cr, 0, 0, Math.max(h, w * g.frac), h, h / 2);
            rgba(cr, g.color, g.dim ? 0.55 : 1);
            cr.fill();
        }
    },
};

const Gauge = GObject.registerClass(
class ClaudeUsageGauge extends St.DrawingArea {
    _init(kind, styleClass, props = {}) {
        super._init({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
        this._kind = kind;
        this.frac = 0;
        this.pace = null;
        this.color = C.session;
        this.dim = false;
        this.showPace = false;
        this.thin = false;
    }

    update({frac = 0, pace = null, color = this.color, dim = false}) {
        this.frac = clamp(frac, 0, 1);
        this.pace = pace;
        this.color = color;
        this.dim = dim;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [w, h] = this.get_surface_size();
            const c = this.get_theme_node().get_foreground_color();
            DRAW[this._kind](cr, w, h, this, [c.red / 255, c.green / 255, c.blue / 255]);
        } finally {
            cr.$dispose();
        }
    }
});

/* ---------- clients ---------- */

// Polling, backoff, caching and change notification; subclasses implement
// _fetch() (ending in _succeed(raw) or _fail(kind)) and _parse(raw).
class PollingClient {
    constructor(name, cacheName) {
        this._name = name;
        this.state = {data: null, fetchedAt: 0, plan: null, error: null};
        this._cachePath = GLib.build_filenamev([CACHE_DIR, cacheName]);
        this._listeners = new Set();
        this._cancellable = new Gio.Cancellable();
        this._timeoutId = 0;
        this._backoff = POLL_SECONDS;
        this._lastAttempt = 0;
        this._inFlight = false;
    }

    start() {
        this._loadCache();
        this.refresh(true);
    }

    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _emit() {
        for (const fn of this._listeners)
            fn();
    }

    refreshIfStale() {
        const now = Date.now() / 1000;
        if (this.state.error || now - this.state.fetchedAt > STALE_ON_OPEN_SECONDS)
            this.refresh();
    }

    refresh(force = false) {
        const now = Date.now() / 1000;
        if (this._inFlight || (!force && now - this._lastAttempt < MIN_GAP_SECONDS))
            return;
        this._lastAttempt = now;
        this._inFlight = true;
        this._fetch();
    }

    _succeed(raw) {
        this._inFlight = false;
        let data = null;
        try {
            data = this._parse(raw);
        } catch {}
        if (!data) {
            this._fail('parse');
            return;
        }
        this.state.data = data;
        if (data.plan)
            this.state.plan = data.plan;
        this.state.fetchedAt = Date.now() / 1000;
        this.state.error = null;
        this._backoff = POLL_SECONDS;
        this._writeCache(raw);
        this._emit();
        this._schedule(this._nextDelay());
    }

    _fail(kind, detail = null) {
        this._inFlight = false;
        const prev = this.state.error;
        if (prev?.kind !== kind || prev?.detail !== detail)
            console.warn(`claude-usage: ${this._name} fetch failed: ${kind}${detail ? ` (${detail})` : ''}`);
        this.state.error = {kind, detail};
        if (['ratelimit', 'network', 'http', 'timeout', 'rpc'].includes(kind))
            this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_SECONDS);
        this._emit();
        this._schedule(this._backoff);
    }

    // Poll on the regular interval, but also right after a window resets.
    _nextDelay() {
        let delay = this._backoff;
        for (const win of [this.state.data?.session, this.state.data?.week]) {
            if (!win?.resetsAt)
                continue;
            const s = secondsUntil(win.resetsAt) + 15;
            if (s > 0 && s < delay)
                delay = s;
        }
        return delay;
    }

    _schedule(seconds) {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(5, Math.round(seconds)), () => {
            this._timeoutId = 0;
            this.refresh(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadCache() {
        try {
            const [, bytes] = GLib.file_get_contents(this._cachePath);
            const cache = JSON.parse(new TextDecoder().decode(bytes));
            const data = this._parse(cache.raw);
            if (data) {
                this.state.data = data;
                this.state.fetchedAt = cache.fetchedAt ?? 0;
                this.state.plan = cache.plan ?? data.plan ?? null;
            }
        } catch {}
    }

    _writeCache(raw) {
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o700);
            GLib.file_set_contents(this._cachePath,
                JSON.stringify({fetchedAt: this.state.fetchedAt, plan: this.state.plan, raw}));
        } catch (e) {
            console.warn(`claude-usage: cannot write cache: ${e.message}`);
        }
    }

    destroy() {
        this._listeners.clear();
        this._cancellable.cancel();
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }
}

class ClaudeClient extends PollingClient {
    constructor() {
        super('claude', 'usage.json');
        this._http = new Soup.Session({timeout: 20, user_agent: 'claude-usage-indicator/1.0'});
        this._debounceId = 0;
        this._watchCredentials();
        this.start();
    }

    _parse(raw) {
        return parseClaude(raw);
    }

    _fetch() {
        const creds = readClaudeCredentials();
        if (creds.plan)
            this.state.plan = creds.plan;
        if (!creds.token) {
            this._fail(creds.expired ? 'expired' : 'nocreds');
            return;
        }

        const msg = Soup.Message.new('GET', CLAUDE_API_URL);
        msg.request_headers.append('Authorization', `Bearer ${creds.token}`);
        msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        msg.request_headers.append('Accept', 'application/json');

        this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (session, res) => {
            let bytes;
            try {
                bytes = session.send_and_read_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._fail('network', e.message);
                return;
            }
            const status = msg.get_status();
            if (status === 401 || status === 403) {
                this._fail('expired');
                return;
            }
            if (status === 429) {
                this._fail('ratelimit');
                return;
            }
            if (status !== 200) {
                this._fail('http', `HTTP ${status}`);
                return;
            }
            let raw = null;
            try {
                raw = JSON.parse(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()));
            } catch {}
            this._succeed(raw);
        });
    }

    // Claude Code rewrites the credentials file when it refreshes its token.
    _watchCredentials() {
        try {
            const dir = Gio.File.new_for_path(CLAUDE_DIR);
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', (_m, file, other) => {
                if (file?.get_basename() !== CLAUDE_CREDENTIALS && other?.get_basename() !== CLAUDE_CREDENTIALS)
                    return;
                const kind = this.state.error?.kind;
                if (kind !== 'expired' && kind !== 'nocreds')
                    return;
                if (this._debounceId)
                    GLib.source_remove(this._debounceId);
                this._debounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                    this._debounceId = 0;
                    this.refresh(true);
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            console.warn(`claude-usage: cannot watch ${CLAUDE_DIR}: ${e.message}`);
        }
    }

    destroy() {
        super.destroy();
        this._http.abort();
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = 0;
        this._monitor?.cancel();
        this._monitor = null;
    }
}

class CodexClient extends PollingClient {
    constructor() {
        super('codex', 'codex.json');
        this._proc = null;
        this._reapers = new Set();
        this.start();
    }

    _parse(raw) {
        return parseCodex(raw);
    }

    // Spawn `codex app-server`, send initialize + account/rateLimits/read in one go,
    // read stdout until the reply arrives, then close stdin (the server exits on EOF).
    _fetch() {
        const codex = findCodex();
        if (!codex) {
            this._fail('nocli');
            return;
        }

        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_SILENCE,
            });
            launcher.set_cwd(GLib.get_home_dir());
            // the npm launcher is `#!/usr/bin/env node`; nvm keeps node next to codex
            launcher.setenv('PATH', `${GLib.path_get_dirname(codex)}:${GLib.getenv('PATH') ?? '/usr/bin:/bin'}`, true);
            proc = launcher.spawnv([codex, 'app-server']);
        } catch (e) {
            this._fail('nocli', e.message);
            return;
        }
        this._proc = proc;

        const stdin = proc.get_stdin_pipe();
        const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        let done = false;
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CODEX_TIMEOUT_SECONDS, () => {
            finish(() => this._fail('timeout'));
            return GLib.SOURCE_REMOVE;
        });

        const finish = report => {
            if (done)
                return;
            done = true;
            GLib.source_remove(timeoutId);
            this._stopProcess(proc);
            report?.();
        };

        const send = requests => {
            const payload = new TextEncoder().encode(requests.map(r => `${JSON.stringify(r)}\n`).join(''));
            stdin.write_bytes_async(new GLib.Bytes(payload), GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                try {
                    s.write_bytes_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        finish(() => this._fail('rpc', e.message));
                }
            });
        };
        send([
            {id: 1, method: 'initialize', params: {
                clientInfo: {name: 'claude-toolkit-usage', title: 'Codex Usage', version: '1.0'},
                capabilities: null,
            }},
            {method: 'initialized'},
            {id: 2, method: 'account/rateLimits/read', params: {excludeResetCreditDetails: true}},
        ]);

        const readLine = () => {
            stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                let line;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        finish();
                    else
                        finish(() => this._fail('rpc', e.message));
                    return;
                }
                if (line === null) {
                    finish(() => this._fail('rpc', 'codex app-server 意外退出'));
                    return;
                }
                let msg = null;
                try {
                    msg = JSON.parse(line);
                } catch {}
                // replies carry our id and no method (server-initiated requests have both)
                const reply = msg && !('method' in msg) && [1, 2, 3].includes(msg.id) ? msg : null;
                if (reply?.error) {
                    const text = reply.error.message ?? '';
                    // older Codex versions take no params for this method: ask again without them
                    if (reply.id === 2 && /expected unit/.test(text)) {
                        send([{id: 3, method: 'account/rateLimits/read'}]);
                        readLine();
                        return;
                    }
                    const kind = /auth|login|token|unauthori[sz]ed|credential/i.test(text) ? 'nocreds' : 'rpc';
                    finish(() => this._fail(kind, text.slice(0, 120)));
                    return;
                }
                if (reply && reply.id !== 1) {
                    finish(() => this._succeed(reply.result));
                    return;
                }
                readLine();
            });
        };
        readLine();
    }

    _stopProcess(proc) {
        if (this._proc === proc)
            this._proc = null;
        try {
            proc.get_stdin_pipe().close(null);
        } catch {}
        // EOF normally ends it within ~0.1 s; SIGTERM (forwarded by the npm launcher) otherwise
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._reapers.delete(id);
            if (proc.get_identifier())
                proc.send_signal(15);
            return GLib.SOURCE_REMOVE;
        });
        this._reapers.add(id);
    }

    destroy() {
        super.destroy();
        for (const id of this._reapers)
            GLib.source_remove(id);
        this._reapers.clear();
        if (this._proc) {
            try {
                this._proc.get_stdin_pipe().close(null);
            } catch {}
            this._proc.send_signal(15);
            this._proc = null;
        }
    }
}

/* ---------- UI ---------- */

function label(styleClass, props = {}) {
    return new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
}

function subdued(actor) {
    actor.opacity = 165;
    return actor;
}

const Indicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(client, provider) {
        super._init(0.5, provider.name, false);
        this._client = client;
        this._provider = provider;

        const box = new St.BoxLayout({style_class: 'claude-usage-panel'});
        this._panelBox = box;
        box.add_child(new Gauge(provider.icon, 'claude-usage-icon'));

        this._sGroup = new St.BoxLayout({style_class: 'claude-usage-group'});
        this._ring = new Gauge('ring', 'claude-usage-ring');
        this._ring.color = C.session;
        this._sessionLabel = label('claude-usage-pct', {text: '–'});
        this._sGroup.add_child(this._ring);
        this._sGroup.add_child(this._sessionLabel);
        box.add_child(this._sGroup);

        this._wGroup = new St.BoxLayout({style_class: 'claude-usage-group'});
        this._pills = new Gauge('pills', 'claude-usage-pills');
        this._pills.color = C.weekly;
        this._weekLabel = label('claude-usage-pct', {text: '–'});
        this._wGroup.add_child(this._pills);
        this._wGroup.add_child(this._weekLabel);
        box.add_child(this._wGroup);

        this.add_child(box);
        this._buildMenu();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._sync();
                this._client.refreshIfStale();
            }
        });
        this._unsubscribe = this._client.subscribe(() => this._sync());
        this.connect('destroy', () => this._unsubscribe());
        this._sync();
    }

    // Plain containers rather than PopupBaseMenuItems: non-activatable menu items are
    // rendered :insensitive (greyed out) by the theme, and these are content, not actions.
    _addItem(child) {
        child.x_expand = true;
        const item = new St.Bin({style_class: 'claude-usage-item', x_expand: true, child});
        this.menu.box.add_child(item);
        return item;
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('claude-usage-menu');

        // header
        const header = new St.BoxLayout({style_class: 'claude-usage-header'});
        header.add_child(new Gauge(this._provider.icon, 'claude-usage-icon-lg'));
        header.add_child(label('claude-usage-title', {text: this._provider.title}));
        header.add_child(new St.Widget({x_expand: true}));
        this._planBadge = label('claude-usage-badge');
        header.add_child(this._planBadge);
        this._addItem(header);

        // status line (errors / limit reached)
        this._status = label('claude-usage-status');
        this._status.clutter_text.line_wrap = true;
        this._statusItem = this._addItem(this._status);

        // short-window card
        const sCard = new St.BoxLayout({style_class: 'claude-usage-card'});
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._bigRing = new Gauge('ring', 'claude-usage-ring-lg');
        this._bigRing.color = C.session;
        this._bigRing.showPace = true;
        this._bigRing.thin = true;
        this._bigRingLabel = label('claude-usage-ring-pct', {x_align: Clutter.ActorAlign.CENTER});
        stack.add_child(this._bigRing);
        stack.add_child(this._bigRingLabel);
        sCard.add_child(stack);

        const sText = new St.BoxLayout({vertical: true, style_class: 'claude-usage-card-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const sTitle = new St.BoxLayout({style_class: 'claude-usage-card-head'});
        sTitle.add_child(this._legendDot(C.session));
        sTitle.add_child(label('claude-usage-card-title', {text: '当前会话'}));
        this._sessionCaption = subdued(label('claude-usage-caption', {text: windowCaption(SESSION_SECONDS)}));
        sTitle.add_child(this._sessionCaption);
        sText.add_child(sTitle);
        this._sessionReset = label('claude-usage-line');
        this._sessionPace = subdued(label('claude-usage-line'));
        sText.add_child(this._sessionReset);
        sText.add_child(this._sessionPace);
        sCard.add_child(sText);
        this._sessionItem = this._addItem(sCard);

        // weekly card
        const wCard = new St.BoxLayout({vertical: true, style_class: 'claude-usage-card claude-usage-card-week'});
        const wHead = new St.BoxLayout({style_class: 'claude-usage-card-head'});
        wHead.add_child(this._legendDot(C.weekly));
        this._weekTitle = label('claude-usage-card-title', {text: longWindowTitle(WEEK_SECONDS)});
        wHead.add_child(this._weekTitle);
        this._weekCaption = subdued(label('claude-usage-caption', {text: windowCaption(WEEK_SECONDS)}));
        wHead.add_child(this._weekCaption);
        wHead.add_child(new St.Widget({x_expand: true}));
        this._weekBig = label('claude-usage-big');
        wHead.add_child(this._weekBig);
        wCard.add_child(wHead);
        this._cells = new Gauge('cells', 'claude-usage-cells', {x_expand: true});
        this._cells.color = C.weekly;
        wCard.add_child(this._cells);
        this._weekReset = label('claude-usage-line');
        this._weekBudget = subdued(label('claude-usage-line'));
        this._weekPace = subdued(label('claude-usage-line'));
        wCard.add_child(this._weekReset);
        wCard.add_child(this._weekBudget);
        wCard.add_child(this._weekPace);

        // extra facts (reset credits, credit balance) and per-model limits, when reported
        this._notes = subdued(label('claude-usage-line claude-usage-notes'));
        wCard.add_child(this._notes);
        this._models = new St.BoxLayout({vertical: true, style_class: 'claude-usage-models'});
        wCard.add_child(this._models);
        this._addItem(wCard);

        // footer
        const footer = new St.BoxLayout({style_class: 'claude-usage-footer'});
        this._updated = subdued(label('claude-usage-updated'));
        footer.add_child(this._updated);
        footer.add_child(new St.Widget({x_expand: true}));
        const refresh = new St.Button({label: '刷新', style_class: 'claude-usage-btn', can_focus: true});
        refresh.connect('clicked', () => this._client.refresh(true));
        const open = new St.Button({label: '用量页面 ↗', style_class: 'claude-usage-btn accent', can_focus: true});
        open.connect('clicked', () => {
            this.menu.close();
            try {
                Gio.AppInfo.launch_default_for_uri(this._provider.usageUrl, null);
            } catch (e) {
                console.warn(`claude-usage: cannot open ${this._provider.usageUrl}: ${e.message}`);
            }
        });
        footer.add_child(refresh);
        footer.add_child(open);
        this._addItem(footer);
    }

    _legendDot(color) {
        return new St.Widget({
            style_class: 'claude-usage-dot',
            style: `background-color: ${cssColor(color)};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _statusText() {
        const {data, error} = this._client.state;
        if (error) {
            const base = this._provider.errors[error.kind] ?? COMMON_ERRORS[error.kind] ?? COMMON_ERRORS.http;
            return error.detail && (error.kind === 'http' || error.kind === 'rpc') ? `${base}（${error.detail}）` : base;
        }
        if (data?.blocked)
            return '已达到用量上限，等待额度重置';
        return null;
    }

    _sync() {
        const {data, error, fetchedAt, plan} = this._client.state;
        const session = data?.session, week = data?.week;
        const dim = !!error && Date.now() / 1000 - fetchedAt > STALE_SECONDS;

        // a tool that isn't installed or signed in at all gets no panel space;
        // polling continues, so it appears once it's set up
        const absent = !data && (error?.kind === 'nocli' || error?.kind === 'nocreds');
        this.visible = !absent;
        if (this.container)
            this.container.visible = !absent;

        // panel — a window the account doesn't have is hidden rather than shown empty
        this._panelBox.opacity = error && !data ? 150 : 255;
        this._sGroup.visible = !data || !!session;
        this._wGroup.visible = !data || !!week;
        this._setPanelMeter(this._ring, this._sessionLabel, session, C.session, dim);
        this._setPanelMeter(this._pills, this._weekLabel, week, C.weekly, dim);

        // header
        this._planBadge.text = plan ?? '';
        this._planBadge.visible = !!plan;
        const status = this._statusText();
        this._status.text = status ?? '';
        this._statusItem.visible = !!status;

        // short window
        this._sessionItem.visible = !data || !!session;
        if (session) {
            const color = levelColor(C.session, session.pct);
            this._bigRing.update({frac: session.pct / 100, pace: paceOf(session), color, dim});
            this._bigRingLabel.text = `${Math.round(session.pct)}%`;
            this._sessionCaption.text = windowCaption(session.duration);
            this._sessionReset.text = resetText(session);
            this._sessionPace.text = paceText(session);
        } else {
            this._bigRing.update({frac: 0, dim});
            this._bigRingLabel.text = '–';
            this._sessionReset.text = '等待数据…';
            this._sessionPace.text = '';
        }

        // week
        if (week) {
            const color = levelColor(C.weekly, week.pct);
            this._cells.update({frac: week.pct / 100, pace: paceOf(week), color, dim});
            this._weekTitle.text = longWindowTitle(week.duration);
            this._weekCaption.text = windowCaption(week.duration);
            this._weekBig.text = `${Math.round(week.pct)}%`;
            this._weekBig.style = week.pct >= 90 ? `color: ${cssColor(C.crit)};` : null;
            this._weekReset.text = resetText(week);
            this._weekBudget.text = dailyBudgetText(week);
            this._weekPace.text = paceText(week);
        } else {
            this._cells.update({frac: 0, dim});
            this._weekBig.text = '–';
            this._weekBig.style = null;
            this._weekReset.text = data ? '暂无每周数据' : '等待数据…';
            this._weekBudget.text = '';
            this._weekPace.text = '';
        }
        this._weekBudget.visible = !!week;
        this._weekPace.visible = !!week;

        const notes = data?.notes ?? [];
        this._notes.text = notes.join(' · ');
        this._notes.visible = notes.length > 0;

        this._models.destroy_all_children();
        for (const m of data?.models ?? []) {
            const row = new St.BoxLayout({style_class: 'claude-usage-model-row'});
            row.add_child(subdued(label('claude-usage-model-name', {text: m.label})));
            const bar = new Gauge('bar', 'claude-usage-bar', {x_expand: true});
            bar.update({frac: m.pct / 100, color: levelColor(C.weekly, m.pct), dim});
            row.add_child(bar);
            row.add_child(label('claude-usage-model-pct', {text: `${Math.round(m.pct)}%`}));
            this._models.add_child(row);
        }
        this._models.visible = (data?.models?.length ?? 0) > 0;

        if (fetchedAt) {
            const at = GLib.DateTime.new_from_unix_local(Math.floor(fetchedAt));
            const today = localDayIndex(at) === localDayIndex(GLib.DateTime.new_now_local());
            this._updated.text = `更新于 ${at.format(today ? '%H:%M' : '%m-%d %H:%M')}`;
        } else {
            this._updated.text = '尚未更新';
        }
    }

    _setPanelMeter(gauge, lbl, win, base, dim) {
        if (!win) {
            gauge.update({frac: 0, dim});
            lbl.text = '–';
            lbl.style = null;
            return;
        }
        const color = levelColor(base, win.pct);
        gauge.update({frac: win.pct / 100, color, dim});
        lbl.text = `${Math.round(win.pct)}%`;
        lbl.style = win.pct >= 75 ? `color: ${cssColor(color)};` : null;
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._clients = [new ClaudeClient(), new CodexClient()];
        const providers = [PROVIDERS.claude, PROVIDERS.codex];
        this._indicators = this._clients.map((client, i) => {
            const indicator = new Indicator(client, providers[i]);
            // The clock (dateMenu) is the first child of the centre box: Claude goes
            // right after it (index 1), Codex right after Claude (index 2).
            Main.panel.addToStatusArea(`${this.uuid}:${providers[i].key}`, indicator, 1 + i, 'center');
            return indicator;
        });
    }

    disable() {
        this._indicators?.forEach(i => i.destroy());
        this._indicators = null;
        this._clients?.forEach(c => c.destroy());
        this._clients = null;
    }
}

/**
 * 平台配置 —— 本插件唯一"易变"的文件。
 *
 * 平台改版时只改这里，src/timeline.js 不需要动。修复流程见 CLAUDE.md。
 * 每个选择器旁注明在真实页面上确认的日期；没有日期的表示还没在真实页面验证过。
 *
 * 字段说明：
 * - id               平台标识，只用于 tlDebug() 输出
 * - hosts            域名；子域名也会匹配。改动时同步 manifest.json 的 matches
 * - turnSelectors    用户提问元素的选择器，按顺序尝试，第一个能匹配到元素的生效。
 *                    平台改版时把新选择器加到最前面，旧的先保留作后备
 * - textSelector     提问文字在提问元素内的位置；匹配多个时拼接，匹配不到用整个元素的文字
 * - scrollMarginTop  跳转后提问距离滚动区域顶部的像素，用来避开平台顶栏
 * - prepare()        可选。每次查找提问前调用，用于预处理 DOM（目前只有 ChatGPT 需要）
 * - getText(el)      可选。自定义取文字，优先级高于 textSelector
 * - listTurns()      可选。平台把视口外的提问整个移出 DOM 时，由平台自己列出全部提问：
 *                    返回 [{ key, el, text }]，el 为 null 表示该提问当前不在 DOM 里；
 *                    返回 null 时退回 turnSelectors。key 必须稳定，列表不变时 key 不变
 * - reveal(item)     可选，配合 listTurns()。点到不在 DOM 里的提问时调用：
 *                    把页面滚动到它附近，等平台渲染出来后返回元素（Promise）；找不到返回 null
 */

'use strict';

// ==================== ChatGPT ====================
//
// ChatGPT 页面结构已知三代，turnSelectors 按新到旧排列：
//
// 1. 2026-11 结构（2026-11-01 在真实页面确认）：
//    每轮"提问 + 回答"包在一个 div[data-turn-key] 里，开头是时间行，
//    提问由隐藏标题 h4[data-conversation-role="user"] 标记，提问气泡是它后面的兄弟 div。
//    未观察到视口外轮次被卸载（3 轮、6 万像素高的对话全部保持渲染）。
//
// 2. 2026-07 虚拟化结构（2026-11 已不存在，保留作后备）：
//    视口外轮次被卸载成空壳：只剩 [data-turn-id-container] 外壳，里面没有 [data-turn]，
//    看不出是提问还是回复。chatgptMarkRoles() 给每个轮次容器打上 data-ait-tl-role，
//    让 turnSelectors 能选中包括空壳在内的全部提问。新结构下找不到容器，直接返回。
//
// 3. 更早的结构：[data-turn="user"][data-turn-id]（2026-11 已不存在，保留作后备）

const CHATGPT_TURN_CONTAINER = '[data-turn-id-container][data-is-intersecting]';
// 新结构的提问气泡 / 旧结构的提问文字；两者不会同时出现在同一轮里
const CHATGPT_TEXT = '[data-conversation-role="user"] ~ div, .whitespace-pre-wrap';
const CHATGPT_TEXT_CACHE_MAX = 500;

// 轮次 id → 提问文字。轮次渲染出来时存下，变成空壳后用于悬停预览。
const chatgptTextCache = new Map();

function chatgptCacheText(id, text) {
    if (!id || !text || chatgptTextCache.get(id) === text) return;
    if (!chatgptTextCache.has(id) && chatgptTextCache.size >= CHATGPT_TEXT_CACHE_MAX) {
        chatgptTextCache.delete(chatgptTextCache.keys().next().value);
    }
    chatgptTextCache.set(id, text);
}

function chatgptMarkRoles() {
    // 已渲染轮次是"外层 DIV 套内层 SECTION"，两层 id 相同。按 id 去重，保留外层（文档序在前）
    const seen = new Set();
    const containers = [];
    for (const el of document.querySelectorAll(CHATGPT_TURN_CONTAINER)) {
        const id = el.getAttribute('data-turn-id-container');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        containers.push(el);
    }
    if (containers.length === 0) return;

    // 从后往前推：已渲染轮次读真实角色，空壳取后一轮的相反角色（提问和回复严格交替）。
    // 最后一轮 ChatGPT 总会渲染，所以链条一定有真实起点
    const roles = new Array(containers.length).fill(null);
    let nextRole = null;
    for (let i = containers.length - 1; i >= 0; i--) {
        const real = containers[i].querySelector('[data-turn]')?.getAttribute('data-turn');
        let role = (real === 'user' || real === 'assistant') ? real : null;
        if (!role && nextRole) role = nextRole === 'user' ? 'assistant' : 'user';
        roles[i] = role;
        if (role) nextRole = role;
    }
    // 开头可能有隐藏的占位轮：第一轮推断成回复时不打标（只跳过，不平移整条链）
    if (roles[0] === 'assistant') roles[0] = null;

    containers.forEach((el, i) => {
        const role = roles[i];
        if (role === 'user') {
            const text = el.querySelector(CHATGPT_TEXT)?.textContent;
            chatgptCacheText(el.getAttribute('data-turn-id-container'), tlCleanText(text));
        }
        // 值没变就不写，避免制造多余的 DOM 变化
        if (role) {
            if (el.getAttribute('data-ait-tl-role') !== role) el.setAttribute('data-ait-tl-role', role);
        } else if (el.hasAttribute('data-ait-tl-role')) {
            el.removeAttribute('data-ait-tl-role');
        }
    });
}

function chatgptGetText(el) {
    const text = tlCleanText(el.querySelector(CHATGPT_TEXT)?.textContent);
    if (text) return text;
    const id = el.getAttribute('data-turn-id-container') || el.getAttribute('data-turn-id');
    return chatgptTextCache.get(id) || '';
}

// ==================== Claude ====================
//
// 2026-11 结构（2026-11-01 在真实页面确认）：
// 对话是虚拟列表，每一行（一条提问或一条回答）是 div[data-index][data-perf-row]：
// - data-index                 行在整个对话里的序号（0 起）
// - data-perf-row              human / assistant
// - data-perf-row-from-tail    距最后一行的距离，所以 总行数 = data-index + 它 + 1
// 视口附近的行才渲染；其余的行整个移出 DOM，上下各用一个 aria-hidden 空块占住高度，
// 不留单独的空壳。所以由 claudeListTurns() 按序号列出全部提问：
// 未渲染行的角色按"提问和回答严格交替"从最近的已渲染行推出。
//
// 更早的结构：[data-test-render-count]:has([data-testid="user-message"])（2026-11 已不存在，保留作后备）

const CLAUDE_ROW = '[data-index][data-perf-row]';
const CLAUDE_TEXT = '[data-testid="user-message"]';
const CLAUDE_TEXT_CACHE_MAX = 500;
const CLAUDE_REVEAL_ATTEMPTS = 8;
const CLAUDE_REVEAL_WAIT_MS = 150;

// "对话路径#行序号" → 提问文字。行渲染出来时存下，移出 DOM 后用于悬停预览。
const claudeTextCache = new Map();

function claudeRowIndex(row) {
    return Number(row.getAttribute('data-index'));
}

function claudeRenderedRows() {
    return [...document.querySelectorAll(CLAUDE_ROW)]
        .filter(row => Number.isInteger(claudeRowIndex(row)))
        .sort((a, b) => claudeRowIndex(a) - claudeRowIndex(b));
}

function claudeTotalRows(rows) {
    const last = rows[rows.length - 1];
    const fromTail = Number(last.getAttribute('data-perf-row-from-tail'));
    return Number.isInteger(fromTail) ? claudeRowIndex(last) + fromTail + 1 : claudeRowIndex(last) + 1;
}

function claudeListTurns() {
    const rows = claudeRenderedRows();
    if (rows.length === 0) return null;

    const byIndex = new Map(rows.map(row => [claudeRowIndex(row), row]));
    const firstIndex = claudeRowIndex(rows[0]);
    const lastIndex = claudeRowIndex(rows[rows.length - 1]);
    const total = claudeTotalRows(rows);

    const roleOf = index => {
        const row = byIndex.get(index);
        if (row) return row.getAttribute('data-perf-row');
        const anchor = index < firstIndex ? firstIndex : lastIndex;
        const anchorRole = byIndex.get(anchor).getAttribute('data-perf-row');
        if ((anchor - index) % 2 === 0) return anchorRole;
        return anchorRole === 'human' ? 'assistant' : 'human';
    };

    const path = location.pathname;
    const items = [];
    for (let index = 0; index < total; index++) {
        if (roleOf(index) !== 'human') continue;
        const key = `${path}#${index}`;
        const el = byIndex.get(index) || null;
        let text = '';
        if (el) {
            text = tlCleanText(el.querySelector(CLAUDE_TEXT)?.textContent);
            if (text) {
                if (!claudeTextCache.has(key) && claudeTextCache.size >= CLAUDE_TEXT_CACHE_MAX) {
                    claudeTextCache.delete(claudeTextCache.keys().next().value);
                }
                claudeTextCache.set(key, text);
            }
        } else {
            text = claudeTextCache.get(key) || '';
        }
        items.push({ key, el, text, index });
    }
    return items;
}

function claudeScroller(el) {
    for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflowY = getComputedStyle(node).overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
}

// 目标行不在 DOM 里：按它在上方/下方空块里的大致比例估算位置，瞬时滚过去，等渲染；
// 估算不准就以新的渲染窗口再估一次，通常 1~2 次就能渲染出来
async function claudeReveal(item) {
    const findRow = () => document.querySelector(`[data-index="${item.index}"][data-perf-row]`);
    for (let attempt = 0; attempt < CLAUDE_REVEAL_ATTEMPTS; attempt++) {
        const found = findRow();
        if (found) return found;

        const rows = claudeRenderedRows();
        if (rows.length === 0) return null;
        const list = rows[0].parentElement;
        const scroller = claudeScroller(list);
        if (!scroller) return null;

        const firstRow = rows[0];
        const lastRow = rows[rows.length - 1];
        const firstIndex = claudeRowIndex(firstRow);
        const lastIndex = claudeRowIndex(lastRow);
        const listRect = list.getBoundingClientRect();
        let targetY;
        if (item.index < firstIndex) {
            const top = listRect.top;
            targetY = top + (firstRow.getBoundingClientRect().top - top) * (item.index / firstIndex);
        } else {
            const bottom = lastRow.getBoundingClientRect().bottom;
            const after = claudeTotalRows(rows) - lastIndex - 1;
            targetY = bottom + (listRect.bottom - bottom) * ((item.index - lastIndex - 1) / Math.max(1, after));
        }
        const scrollerTop = scroller.getBoundingClientRect().top;
        // 不能一步落到最底部：2026-11-01 实测从顶部瞬时滚到底部后，Claude 会把后续的
        // 程序滚动全部拉回底部（之后的跳转完全无效）；离底半屏以上则正常。
        // 目标在底部附近时，停在离底半屏处它也在可见范围内，照样会被渲染
        const maxTop = scroller.scrollHeight - scroller.clientHeight - scroller.clientHeight / 2;
        const nextTop = scroller.scrollTop + targetY - scrollerTop - scroller.clientHeight / 3;
        scroller.scrollTop = Math.max(0, Math.min(nextTop, maxTop));
        await new Promise(resolve => setTimeout(resolve, CLAUDE_REVEAL_WAIT_MS));
    }
    return findRow();
}

// ==================== 平台列表 ====================

const TL_PLATFORMS = [
    {
        id: 'chatgpt',
        hosts: ['chatgpt.com', 'chat.openai.com'],
        // 只对 2026-07 虚拟化结构起作用，其他结构下找不到容器直接返回
        prepare: chatgptMarkRoles,
        // 按新到旧排列，见上方说明
        turnSelectors: [
            '[data-turn-key]:has([data-conversation-role="user"])',  // 2026-11 结构（2026-11-01 确认）
            '[data-turn-id-container][data-ait-tl-role="user"]',     // 2026-07 虚拟化结构（由 prepare 打标）
            '[data-turn="user"][data-turn-id]',                     // 更早的结构
        ],
        textSelector: CHATGPT_TEXT,
        getText: chatgptGetText,
        // 2026-11 实测：顶栏 header 固定 52px；跳转停下后 ChatGPT 会自行微调约 ±13px，
        // 68 能保证提问气泡始终落在顶栏下方 3~28px
        scrollMarginTop: 68,
    },
    {
        id: 'claude',
        hosts: ['claude.ai'],
        // 2026-11 虚拟列表结构，见上方说明；找不到虚拟列表行时退回 turnSelectors
        listTurns: claudeListTurns,
        reveal: claudeReveal,
        // 第 1 个用于给 listTurns 的行加跳转留白，第 2 个是更早的结构
        turnSelectors: [
            '[data-index][data-perf-row="human"]',
            '[data-test-render-count]:has([data-testid="user-message"])',
        ],
        // 2026-11-01 确认：整行还含时间等文字，只取提问本身（多段落时包含全部段落）
        textSelector: CLAUDE_TEXT,
        // 2026-11-01 实测：滚动容器自带 scroll-padding-top: 45px（正好避开顶栏），会叠加
        scrollMarginTop: 12,
    },
    {
        id: 'gemini',
        hosts: ['gemini.google.com'],
        // 2026-11-01 确认；user-query 的文字比提问本身多（实测 30 字 vs 10 字），
        // 所以只取 .query-text-line（提问正文，多行时拼接）
        turnSelectors: ['user-query'],
        textSelector: '.query-text-line',
        // 2026-11-01 实测：滚动容器 infinite-scroller 自带 scroll-padding-top: 56px（正好避开顶栏），
        // 会和这里叠加，所以只需留一点空隙：提问气泡稳定落在顶栏下方 11px
        scrollMarginTop: 12,
    },
];

// ==================== 工具 ====================

// 压缩空白；platforms.js 和 timeline.js 共用
function tlCleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

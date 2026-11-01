/**
 * 时间轴核心 —— 与平台无关，平台差异全部在 src/platforms.js。
 *
 * 流程：查找提问 → 和上次比较 → 有变化就重建圆点 → 点击圆点跳转。
 * 发新提问、切换对话都会引起 DOM 变化，统一由一个 MutationObserver 驱动，不监听 URL。
 */

(() => {
    'use strict';

    if (window.__aiTimeline) return;
    window.__aiTimeline = true;

    const host = location.hostname;
    const platform = TL_PLATFORMS.find(p =>
        p.hosts.some(h => host === h || host.endsWith(`.${h}`))
    );
    if (!platform) return;

    const UPDATE_INTERVAL_MS = 300;  // DOM 变化后最多每 300ms 重新查找一次
    const TITLE_MAX_LENGTH = 200;
    const SCROLL_FIX_TIMEOUT_MS = 2000;  // 收不到 scrollend 时的兜底；长距离平滑滚动约需 1.2 秒

    // ---------- 跳转留白：scrollIntoView 会遵守 scroll-margin-top ----------
    const style = document.createElement('style');
    style.textContent = `${platform.turnSelectors.join(',\n')} {
        scroll-margin-top: ${platform.scrollMarginTop}px !important;
    }`;
    document.documentElement.appendChild(style);

    // ---------- 圆点列 ----------
    // 挂在 <html> 下而不是 <body> 下：DOM 监听只覆盖 body，重建圆点不会触发自己；
    // 平台框架重渲染 body 时也不会把它删掉
    const bar = document.createElement('nav');
    bar.className = 'ait-tl-bar';
    bar.setAttribute('aria-label', 'Chat timeline');
    bar.hidden = true;
    document.documentElement.appendChild(bar);

    let turns = [];
    let matchedSelector = null;

    function findTurns() {
        try { platform.prepare?.(); } catch {}

        for (const selector of platform.turnSelectors) {
            let found;
            try { found = document.querySelectorAll(selector); } catch { continue; }
            if (found.length === 0) continue;

            // 去掉嵌套在另一个匹配元素里的元素（文档序中祖先总在前面）
            const result = [];
            for (const el of found) {
                const last = result[result.length - 1];
                if (!last || !last.contains(el)) result.push(el);
            }
            return { selector, turns: result };
        }
        return { selector: null, turns: [] };
    }

    function getText(el) {
        let text = '';
        try {
            if (platform.getText) {
                text = platform.getText(el);
            } else {
                const parts = platform.textSelector ? el.querySelectorAll(platform.textSelector) : [];
                text = parts.length
                    ? Array.from(parts, node => node.textContent).join(' ')
                    : el.textContent;
            }
        } catch {}
        text = tlCleanText(text);
        return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH)}…` : text;
    }

    function setDotText(dot, index, text) {
        dot.title = text ? `${index + 1}. ${text}` : `#${index + 1}`;
        dot.setAttribute('aria-label', dot.title);
        dot.dataset.hasText = text ? '1' : '';
    }

    function render() {
        const found = findTurns();
        matchedSelector = found.selector;
        const next = found.turns;

        // 数量相同且每个元素都是同一个 DOM 节点 → 结构没变。
        // AI 流式输出期间基本都走这里，只补齐之前没取到的文字（如 ChatGPT 空壳后来渲染出来了）
        if (next.length === turns.length && next.every((el, i) => el === turns[i])) {
            bar.querySelectorAll('.ait-tl-dot:not([data-has-text="1"])').forEach(dot => {
                const index = Number(dot.dataset.index);
                const text = getText(turns[index]);
                if (text) setDotText(dot, index, text);
            });
            return;
        }

        turns = next;
        bar.replaceChildren(...turns.map((el, index) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'ait-tl-dot';
            dot.dataset.index = String(index);
            setDotText(dot, index, getText(el));
            return dot;
        }));
        bar.hidden = turns.length === 0;
    }

    // ---------- 跳转 ----------
    // 平滑滚动过程中，上方内容可能高度变化（ChatGPT 空壳被渲染出来等），导致停下时偏离目标。
    // 滚动结束后再瞬时对齐一次；已经对齐时这一步没有视觉变化。用户中途自己滚动就不再校正
    let cancelScrollFix = null;

    function jumpTo(el) {
        cancelScrollFix?.();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });

        let timer = 0;
        const fix = () => {
            cleanup();
            if (el.isConnected) el.scrollIntoView({ behavior: 'instant', block: 'start' });
        };
        const cleanup = () => {
            clearTimeout(timer);
            document.removeEventListener('scrollend', fix, true);
            for (const type of ['wheel', 'touchstart', 'keydown']) {
                window.removeEventListener(type, cleanup, true);
            }
            cancelScrollFix = null;
        };
        // scrollend 不冒泡，但捕获阶段能在 document 上收到任意滚动容器的事件
        document.addEventListener('scrollend', fix, true);
        for (const type of ['wheel', 'touchstart', 'keydown']) {
            window.addEventListener(type, cleanup, { capture: true, passive: true });
        }
        timer = setTimeout(fix, SCROLL_FIX_TIMEOUT_MS);
        cancelScrollFix = cleanup;
    }

    bar.addEventListener('click', event => {
        const dot = event.target.closest('.ait-tl-dot');
        if (!dot) return;
        const index = Number(dot.dataset.index);
        // 切换对话的瞬间，旧元素可能已被移除：先刷新一次再按序号找
        if (!turns[index]?.isConnected) render();
        const el = turns[index];
        if (el?.isConnected) jumpTo(el);
    });

    // ---------- 自动更新：节流而不是防抖 ----------
    // AI 流式输出时 DOM 每几十毫秒就变一次，防抖会一直被推迟，新提问的圆点迟迟不出现
    let updateTimer = 0;
    new MutationObserver(() => {
        if (updateTimer) return;
        updateTimer = setTimeout(() => {
            updateTimer = 0;
            render();
        }, UPDATE_INTERVAL_MS);
    }).observe(document.body, { childList: true, subtree: true });

    render();

    // ---------- 排查入口 ----------
    // DevTools Console 顶部的上下文下拉框选择本扩展，然后运行 tlDebug()
    globalThis.tlDebug = () => {
        render();
        const selectorCounts = {};
        for (const selector of platform.turnSelectors) {
            try { selectorCounts[selector] = document.querySelectorAll(selector).length; }
            catch (e) { selectorCounts[selector] = `invalid: ${e.message}`; }
        }
        return {
            platform: platform.id,
            matchedSelector,
            selectorCounts,
            turns: turns.length,
            withoutText: bar.querySelectorAll('.ait-tl-dot:not([data-has-text="1"])').length,
            sample: turns.slice(0, 3).map(getText),
        };
    };
})();

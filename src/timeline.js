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

    // ---------- 悬停提示 ----------
    // 自己画而不用 title：浏览器原生提示要停留约 1 秒才出现
    const tip = document.createElement('div');
    tip.className = 'ait-tl-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.documentElement.appendChild(tip);
    let tipDot = null;

    function showTip(dot) {
        tipDot = dot;
        tip.textContent = dot.getAttribute('aria-label');
        tip.hidden = false;
        // 显示在圆点左侧、垂直居中，上下不超出视口
        const r = dot.getBoundingClientRect();
        const margin = 8;
        tip.style.right = `${window.innerWidth - r.left + 6}px`;
        const half = tip.offsetHeight / 2;
        const center = Math.min(
            Math.max(r.top + r.height / 2, margin + half),
            window.innerHeight - margin - half
        );
        tip.style.top = `${center - half}px`;
    }

    function hideTip() {
        tipDot = null;
        tip.hidden = true;
    }

    bar.addEventListener('mouseover', event => {
        const dot = event.target.closest('.ait-tl-dot');
        if (dot && dot !== tipDot) showTip(dot);
    });
    bar.addEventListener('mouseleave', hideTip);
    bar.addEventListener('focusin', event => {
        const dot = event.target.closest('.ait-tl-dot');
        if (dot) showTip(dot);
    });
    bar.addEventListener('focusout', hideTip);
    // 圆点列自身滚动时圆点会移动，提示位置就不对了
    bar.addEventListener('scroll', hideTip, { passive: true });

    // 每条提问是一个 { key, el, text? }：
    // - key   稳定标识，用来判断提问列表有没有变
    // - el    提问元素；平台把视口外的提问整个移出 DOM 时为 null（由 platform.reveal 负责找回）
    // - text  可选，平台已经取好的文字
    let turns = [];
    let matchedSelector = null;

    function findTurns() {
        // 平台自己列出全部提问（用于把视口外提问移出 DOM 的平台）
        if (platform.listTurns) {
            let items = null;
            try { items = platform.listTurns(); } catch {}
            if (items) return { selector: 'listTurns()', turns: items };
        }

        try { platform.prepare?.(); } catch {}

        for (const selector of platform.turnSelectors) {
            let found;
            try { found = document.querySelectorAll(selector); } catch { continue; }
            if (found.length === 0) continue;

            // 去掉嵌套在另一个匹配元素里的元素（文档序中祖先总在前面）
            const result = [];
            for (const el of found) {
                const last = result[result.length - 1];
                if (!last || !last.el.contains(el)) result.push({ key: el, el });
            }
            return { selector, turns: result };
        }
        return { selector: null, turns: [] };
    }

    function turnText(item) {
        if (item.text) return item.text;
        return item.el ? getText(item.el) : '';
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
        return tlCleanText(text);
    }

    function setDotText(dot, index, text) {
        text = tlCleanText(text);
        if (text.length > TITLE_MAX_LENGTH) text = `${text.slice(0, TITLE_MAX_LENGTH)}…`;
        dot.setAttribute('aria-label', text ? `${index + 1}. ${text}` : `#${index + 1}`);
        dot.dataset.hasText = text ? '1' : '';
        if (dot === tipDot) showTip(dot);
    }

    function render() {
        const found = findTurns();
        matchedSelector = found.selector;
        const next = found.turns;

        // 数量相同且 key 逐个相同 → 提问列表没变，不重建圆点。
        // AI 流式输出期间基本都走这里：只更新元素引用（虚拟列表滚动时元素会进出 DOM），
        // 并补齐之前没取到的文字（如 ChatGPT 空壳、Claude 视口外的提问后来渲染出来了）
        if (next.length === turns.length && next.every((item, i) => item.key === turns[i].key)) {
            turns = next;
            bar.querySelectorAll('.ait-tl-dot:not([data-has-text="1"])').forEach(dot => {
                const index = Number(dot.dataset.index);
                const text = turnText(turns[index]);
                if (text) setDotText(dot, index, text);
            });
            return;
        }

        turns = next;
        hideTip();
        bar.replaceChildren(...turns.map((item, index) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'ait-tl-dot';
            dot.dataset.index = String(index);
            setDotText(dot, index, turnText(item));
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

    // 连续点击时只执行最后一次的 reveal 结果
    let revealSeq = 0;

    bar.addEventListener('click', event => {
        const dot = event.target.closest('.ait-tl-dot');
        if (!dot) return;
        const index = Number(dot.dataset.index);
        const seq = ++revealSeq;
        // 切换对话的瞬间、或虚拟列表刚换过渲染窗口，旧元素可能已被移除：先刷新一次再按序号找
        if (!turns[index]?.el?.isConnected) render();
        const item = turns[index];
        if (!item) return;
        if (item.el?.isConnected) {
            jumpTo(item.el);
        } else if (platform.reveal) {
            // 提问不在 DOM 里：交给平台先滚动到附近、等它渲染出来
            Promise.resolve(platform.reveal(item))
                .then(el => { if (seq === revealSeq && el?.isConnected) jumpTo(el); })
                .catch(() => {});
        }
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
            notInDom: turns.filter(item => !item.el?.isConnected).length,
            withoutText: bar.querySelectorAll('.ait-tl-dot:not([data-has-text="1"])').length,
            sample: turns.slice(0, 3).map(turnText),
        };
    };
})();

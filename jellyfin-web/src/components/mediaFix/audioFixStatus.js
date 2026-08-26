import escapeHtml from 'escape-html';
import globalize from '../../lib/globalize';
import itemHelper from '../itemHelper';
import { getMediaFixHelperUrl } from '../../scripts/settings/webSettings';
import '../indicators/indicators.scss';
import './audioFixStatus.scss';

const POLL_INTERVAL_MS = 4000;

let pollTimer = null;
let pollToken = 0;

function setRowHidden(page, hidden) {
    const row = page.querySelector('.audioFixStatusContainer');
    if (row) {
        row.classList.toggle('hide', hidden);
    }
}

function renderIdle(page, fixed) {
    const el = page.querySelector('.audioFixStatusValue');
    if (!el) return;
    el.textContent = globalize.translate(fixed ? 'AudioFixYes' : 'AudioFixNo');
}

function renderRunning(page, phase, pct) {
    const el = page.querySelector('.audioFixStatusValue');
    if (!el) return;
    const width = pct == null ? 0 : pct;
    const phaseText = escapeHtml(phase || globalize.translate('AudioFixStarting'));
    const pctText = pct == null ? '' : ` ${pct}%`;
    el.innerHTML = `<div class="itemProgressBar" style="max-width:12em;margin-bottom:0.3em;"><div class="itemProgressBarForeground" style="width:${width}%;"></div></div>${phaseText}${pctText}`;
}

export function stop() {
    pollToken++;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

export function render(page, item, user) {
    stop();

    const path = item.Path;
    if (!itemHelper.canRunMediaFix(user, item) || !path || !path.startsWith('/MEDIA/')) {
        setRowHidden(page, true);
        return;
    }

    setRowHidden(page, false);
    renderIdle(page, false);

    const myToken = ++pollToken;

    async function tick() {
        if (myToken !== pollToken) return;

        let helperUrl;
        try {
            helperUrl = await getMediaFixHelperUrl();
        } catch {
            return;
        }
        if (myToken !== pollToken) return;

        try {
            const response = await fetch(`${helperUrl}/status?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
            if (myToken !== pollToken) return;
            if (response.ok) {
                const data = await response.json();
                if (myToken !== pollToken) return;
                if (data.state === 'running') {
                    renderRunning(page, data.progressPhase, data.progressPercent);
                } else {
                    renderIdle(page, !!data.fixed);
                }
            }
        } catch {
            // transient network error; keep the last shown state and try again next tick
        }

        if (myToken === pollToken) {
            pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        }
    }

    tick();
}

export default { render, stop };

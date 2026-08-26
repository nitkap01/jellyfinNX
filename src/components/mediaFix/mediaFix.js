import globalize from '../../lib/globalize';
import confirm from '../confirm/confirm';
import alert from '../alert';
import loading from '../loading/loading';
import toast from '../toast/toast';
import { getMediaFixHelperUrl } from '../../scripts/settings/webSettings';

const POLL_INTERVAL_MS = {
    'fix-subtitle': 2000,
    'fix-audio': 10000
};

const POLL_HARD_CAP_MS = {
    'fix-subtitle': 5 * 60 * 1000,
    'fix-audio': 45 * 60 * 1000
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolvePath(apiClient, item) {
    const full = await apiClient.getItem(apiClient.getCurrentUserId(), item.Id);
    const path = full?.Path;
    if (!path) {
        throw new Error(globalize.translate('MediaFixNoPath'));
    }
    if (!path.startsWith('/MEDIA/')) {
        throw new Error(globalize.translate('MediaFixNotUnderMedia'));
    }
    return path;
}

async function startJob(helperUrl, action, path) {
    let response;
    try {
        response = await fetch(`${helperUrl}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, path })
        });
    } catch (err) {
        throw new Error(globalize.translate('MediaFixUnreachable', helperUrl));
    }

    if (response.status === 202) {
        return response.json();
    }

    let body = {};
    try {
        body = await response.json();
    } catch { /* ignore parse failure, fall through to generic message */ }

    if (response.status === 409) {
        throw new Error(globalize.translate('FixAudioAlreadyRunning'));
    }
    throw new Error(body.detail || body.error || `HTTP ${response.status}`);
}

async function pollJob(helperUrl, jobId, action) {
    const interval = POLL_INTERVAL_MS[action];
    const cap = POLL_HARD_CAP_MS[action];
    const start = Date.now();
    let consecutiveFailures = 0;

    while (Date.now() - start < cap) {
        await sleep(interval);

        let response;
        try {
            response = await fetch(`${helperUrl}/jobs/${jobId}`, { cache: 'no-store' });
            consecutiveFailures = 0;
        } catch {
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
                return { timedOut: false, lostConnection: true };
            }
            continue;
        }

        if (!response.ok) {
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
                return { timedOut: false, lostConnection: true };
            }
            continue;
        }

        const job = await response.json();
        if (job.state !== 'running') {
            return { timedOut: false, lostConnection: false, job };
        }
    }

    return { timedOut: true, lostConnection: false };
}

function subtitleMessage(job) {
    if (job.state === 'succeeded') {
        return globalize.translate('MediaFixSubSuccess');
    }
    switch (job.exitCode) {
        case 1: return globalize.translate('MediaFixSubExit1');
        case 2: return `${globalize.translate('MediaFixSubExit2')}\n\n${(job.output || '').split('\n').slice(-10).join('\n')}`;
        case 3: return globalize.translate('MediaFixSubExit3');
        case 4: return globalize.translate('MediaFixSubExit4');
        case 6: return globalize.translate('MediaFixSubExit6');
        default: return `${globalize.translate('MediaFixSubExitOther', job.exitCode)}\n\n${(job.output || '').slice(-2000)}`;
    }
}

function audioMessage(job) {
    const status = job.resultStatus;
    const output = job.output || '';

    if (status === 'OK_NOFIX') return { text: globalize.translate('MediaFixAudioNoFix'), refresh: false, title: undefined };
    if (status === 'OK_FIXED' || (job.exitCode === 0 && !status)) return { text: globalize.translate('MediaFixAudioFixed'), refresh: true, title: undefined };
    if (status === 'OK_LOCAL_ONLY') return { text: globalize.translate('MediaFixAudioLocalOnly'), refresh: true, title: undefined };

    switch (job.exitCode) {
        case 1:
            return { text: globalize.translate('MediaFixAudioExit1'), refresh: false };
        case 2:
            if (output.includes('Another run is already in progress')) return { text: globalize.translate('MediaFixAudioExit2Running'), refresh: false };
            if (output.includes('Already processed')) return { text: globalize.translate('MediaFixAudioExit2Processed'), refresh: false };
            if (output.includes('Ambiguous')) return { text: `${globalize.translate('MediaFixAudioExit2Ambiguous')}\n\n${output.split('\n').slice(-10).join('\n')}`, refresh: false };
            if (output.includes('Not enough')) return { text: globalize.translate('MediaFixAudioExit2Space'), refresh: false };
            return { text: `${globalize.translate('MediaFixAudioExit2Other')}\n\n${output.slice(-2000)}`, refresh: false };
        case 3:
            return { text: globalize.translate('MediaFixAudioExit3'), refresh: false };
        case 4:
            return { text: globalize.translate('MediaFixAudioExit4'), refresh: false };
        case 5:
            return { text: globalize.translate('MediaFixAudioExit5'), refresh: false };
        case 6:
            return { text: globalize.translate('MediaFixAudioExit6'), refresh: false };
        case 7:
            return { text: globalize.translate('MediaFixAudioExit7'), refresh: false };
        case 8:
            return { text: `${globalize.translate('MediaFixAudioExit8')}\n\n${output}`, refresh: false, title: globalize.translate('MediaFixNeedsHuman') };
        default:
            return { text: `${globalize.translate('MediaFixAudioExitOther', job.exitCode)}\n\n${output.slice(-2000)}`, refresh: false };
    }
}

export async function runMediaFix(action, item, apiClient) {
    const helperUrl = await getMediaFixHelperUrl();

    let path;
    try {
        path = await resolvePath(apiClient, item);
    } catch (err) {
        await alert(err.message);
        return;
    }

    if (action === 'fix-audio') {
        try {
            await confirm({
                title: globalize.translate('FixAudio'),
                text: globalize.translate('FixAudioConfirm'),
                confirmText: globalize.translate('ButtonStart')
            });
        } catch {
            return;
        }
    }

    let startResult;
    try {
        startResult = await startJob(helperUrl, action, path);
    } catch (err) {
        await alert(err.message);
        return;
    }

    const showSpinner = action === 'fix-subtitle';
    if (showSpinner) {
        loading.show();
    } else {
        toast(globalize.translate('FixAudioStarted'));
    }

    let outcome;
    try {
        outcome = await pollJob(helperUrl, startResult.jobId, action);
    } finally {
        if (showSpinner) {
            loading.hide();
        }
    }

    if (outcome.timedOut) {
        await alert(globalize.translate('MediaFixStillRunning', startResult.jobId));
        return;
    }
    if (outcome.lostConnection) {
        await alert(globalize.translate('MediaFixLostConnection', startResult.jobId));
        return;
    }

    const job = outcome.job;

    if (action === 'fix-subtitle') {
        await alert(subtitleMessage(job));
        if (job.state === 'succeeded') {
            apiClient.refreshItem(item.Id, {
                Recursive: false,
                ImageRefreshMode: 'Default',
                MetadataRefreshMode: 'Default',
                ReplaceAllImages: false,
                ReplaceAllMetadata: false
            });
        }
        return;
    }

    const { text, refresh, title } = audioMessage(job);
    await alert(title ? { text, title } : text);
    if (refresh) {
        apiClient.refreshItem(item.Id, {
            Recursive: false,
            ImageRefreshMode: 'Default',
            MetadataRefreshMode: 'Default',
            ReplaceAllImages: false,
            ReplaceAllMetadata: false
        });
    }
}

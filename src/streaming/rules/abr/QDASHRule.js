import BufferController from '../../controllers/BufferController';
import EventBus from '../../../core/EventBus';
import Events from '../../../core/events/Events';
import FactoryMaker from '../../../core/FactoryMaker';
import Debug from '../../../core/Debug';
import SwitchRequest from '../SwitchRequest.js';

function QDASHRule(config) {

    config = config || {};

    const context = this.context;
    const log = Debug(context).getInstance().log;

    const eventBus = EventBus(context).getInstance();
    const metricsModel = config.metricsModel;
    const dashMetrics = config.dashMetrics;

    const QDashStates = {
        STABLE: 0, // throughput and bitrate are close
        TRANSITION: 1 // throughput and bitrate differ
    };

    const epsilon = 0; // some buffer for rounding errors, etc

    let qs = {
        currentState: QDashStates.STABLE,
        oldThroughput: 0,
        currentThroughput: 0,
        throughputDelta: 0, // this triggers state changes
        nfrag: 0, // number of intermediate chunks to download
        tbuffer: 0,
        sfrag: 0,
        newBitrate: 0,
        oldBitrate: 0
    };

    let instance,
        bufferStateDict;

    function setup() {
        resetInitialSettings();
        eventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
    }

    function checkConfig() {
        if (!metricsModel || !metricsModel.hasOwnProperty('getReadOnlyMetricsFor') || !dashMetrics || !dashMetrics.hasOwnProperty('getCurrentBufferLevel')) {
            throw new Error('Missing config parameter(s)');
        }
    }

    function getMaxIndex (rulesContext) {
        const switchRequest = SwitchRequest(context).create();

        if (!rulesContext || !rulesContext.hasOwnProperty('getMediaType')) {
            return switchRequest;
        }

        checkConfig();

        const mediaType = rulesContext.getMediaType();
        const metrics = metricsModel.getReadOnlyMetricsFor(mediaType);
        const lastBufferStateVO = (metrics.BufferState.length > 0) ? metrics.BufferState[metrics.BufferState.length - 1] : null;
        const representationInfo = rulesContext.getRepresentationInfo();
        const fragmentDuration = representationInfo.fragmentDuration;

        // Don't ask for a bitrate change if there is not info about buffer state or if fragmentDuration is not defined
        if (!lastBufferStateVO || !wasFirstBufferLoadedEventTriggered(mediaType, lastBufferStateVO) || !fragmentDuration) {
            return switchRequest;
        }

        if (lastBufferStateVO.state === BufferController.BUFFER_EMPTY) {
            log('Switch to index 0; buffer is empty.');
            switchRequest.quality = 0;
            switchRequest.reason = 'QDASH: Buffer is empty';
        } else {
            const mediaInfo = rulesContext.getMediaInfo();
            const abrController = rulesContext.getAbrController();
            const throughputHistory = abrController.getThroughputHistory();
            const bitrateList = abrController.getBitrateList(mediaInfo);

            const bufferLevel = dashMetrics.getCurrentBufferLevel(metrics);
            const throughput = throughputHistory.getAverageThroughput(mediaType);
            const latency = throughputHistory.getAverageLatency(mediaType);

            // throughput delta update
            qs.oldThroughput = qs.currentThroughput;
            qs.currentThroughput = throughput;
            qs.throughputDelta = qs.currentThroughput - qs.oldThroughput;

            var getIntermediateQualityIdx = function (br0, br1) {
                const q0 = abrController.getQualityForBitrate(mediaInfo, br0, latency);
                const q1 = abrController.getQualityForBitrate(mediaInfo, br1, latency);
                return Math.floor((q0 + q1) / 2); // some quality index between the two
            };

            switch (qs.currentState) {
                case QDashStates.STABLE:
                    if (qs.throughputDelta < -epsilon || qs.throughputDelta > epsilon) {
                        // throughput has changed
                        qs.oldBitrate = qs.oldThroughput;
                        qs.newBitrate = qs.currentThroughput;
                        const intermediateQualityIdx = getIntermediateQualityIdx(qs.oldBitrate, qs.newBitrate);
                        const intermediateBitrate = bitrateList[intermediateQualityIdx] / 1000;
                        qs.sfrag = intermediateBitrate * fragmentDuration;
                        qs.tbuffer = bufferLevel;
                        qs.nfrag = qs.tbuffer * qs.newBitrate / qs.sfrag;
                        qs.currentState = QDashStates.TRANSITION;
                        switchRequest.quality = intermediateQualityIdx;
                    }
                    break;
                case QDashStates.TRANSITION:
                    if (qs.nfrag <= 0) {
                        // out of runway
                        switchRequest.quality = abrController.getQualityForBitrate(mediaInfo, qs.newBitrate, latency);
                        qs.currentState = QDashStates.STABLE;
                    } else {
                        qs.nfrag -= 1;
                    }
                    break;
            }
        }

        return switchRequest;
    }

    function wasFirstBufferLoadedEventTriggered(mediaType, currentBufferState) {
        bufferStateDict[mediaType] = bufferStateDict[mediaType] || {};

        let wasTriggered = false;
        if (bufferStateDict[mediaType].firstBufferLoadedEvent) {
            wasTriggered = true;
        } else if (currentBufferState && currentBufferState.state === BufferController.BUFFER_LOADED) {
            bufferStateDict[mediaType].firstBufferLoadedEvent = true;
            wasTriggered = true;
        }
        return wasTriggered;
    }

    function resetInitialSettings() {
        bufferStateDict = {};
    }

    function onPlaybackSeeking() {
        resetInitialSettings();
    }

    function reset() {
        resetInitialSettings();
        eventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
    }

    instance = {
        getMaxIndex: getMaxIndex,
        reset: reset
    };

    setup();

    return instance;
}

QDASHRule.__dashjs_factory_name = 'QDASHRule';
export default FactoryMaker.getClassFactory(QDASHRule);

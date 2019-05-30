import bindAll from 'lodash.bindall';
import PropTypes from 'prop-types';
import React from 'react';
import WavEncoder from 'wav-encoder';
import VM from 'scratch-vm';

import {connect} from 'react-redux';

import {computeChunkedRMS, SOUND_BYTE_LIMIT} from '../lib/audio/audio-util.js';
import AudioEffects from '../lib/audio/audio-effects.js';
import SoundEditorComponent from '../components/sound-editor/sound-editor.jsx';
import AudioBufferPlayer from '../lib/audio/audio-buffer-player.js';
import log from '../lib/log.js';

const UNDO_STACK_SIZE = 99;

import SharedAudioContext from '../lib/audio/shared-audio-context.js';

/* eslint-disable import/no-unresolved */
import reverbImpulseResponse from '!arraybuffer-loader!../lib/audio/york-minster-short.wav';
import magicImpulseResponse from '!arraybuffer-loader!../lib/audio/magic-spell.wav';
/* eslint-enable import/no-unresolved */

class SoundEditor extends React.Component {
    constructor (props) {
        super(props);
        bindAll(this, [
            'copy',
            'copyCurrentBuffer',
            'handleCopyToNew',
            'handleStoppedPlaying',
            'handleChangeName',
            'handlePlay',
            'handleStopPlaying',
            'handleUpdatePlayhead',
            'handleActivateTrim',
            'handleUpdateTrim',
            'handleEffect',
            'handleUndo',
            'handleRedo',
            'submitNewSamples',
            'handleCopy',
            'handlePaste',
            'paste'
        ]);
        this.state = {
            copyBuffer: null,
            chunkLevels: computeChunkedRMS(this.props.samples),
            playhead: null, // null is not playing, [0 -> 1] is playing percent
            trimStart: null,
            trimEnd: null
        };

        this.redoStack = [];
        this.undoStack = [];

        this.audioContext = new SharedAudioContext();
        const {effectTypes} = AudioEffects;
        this.impulseResponses = {};
        this.audioContext.decodeAudioData(reverbImpulseResponse.slice(0)).then(buffer => {
            this.impulseResponses[effectTypes.REVERB] = buffer;
        });
        this.audioContext.decodeAudioData(magicImpulseResponse.slice(0)).then(buffer => {
            this.impulseResponses[effectTypes.MAGIC] = buffer;
        });
    }
    componentDidMount () {
        this.audioBufferPlayer = new AudioBufferPlayer(this.props.samples, this.props.sampleRate);
    }
    componentWillReceiveProps (newProps) {
        if (newProps.soundId !== this.props.soundId) { // A different sound has been selected
            this.redoStack = [];
            this.undoStack = [];
            this.resetState(newProps.samples, newProps.sampleRate);
            this.setState({
                trimStart: null,
                trimEnd: null
            });
        }
    }
    componentWillUnmount () {
        this.audioBufferPlayer.stop();
    }
    resetState (samples, sampleRate) {
        this.audioBufferPlayer.stop();
        this.audioBufferPlayer = new AudioBufferPlayer(samples, sampleRate);
        this.setState({
            chunkLevels: computeChunkedRMS(samples),
            playhead: null
        });
    }
    submitNewSamples (samples, sampleRate, skipUndo) {
        // Encode the new sound into a wav so that it can be stored
        let wavBuffer = null;
        try {
            wavBuffer = WavEncoder.encode.sync({
                sampleRate: sampleRate,
                channelData: [samples]
            });

            if (wavBuffer.byteLength > SOUND_BYTE_LIMIT) {
                // Cancel the sound update by setting to null
                wavBuffer = null;
                log.error(`Refusing to encode sound larger than ${SOUND_BYTE_LIMIT} bytes`);
            }
        } catch (e) {
            // This error state is mostly for the mock sounds used during testing.
            // Any incorrect sound buffer trying to get interpretd as a Wav file
            // should yield this error.
            // This can also happen if the sound is too be allocated in memory.
            log.error(`Encountered error while trying to encode sound update: ${e}`);
        }

        // Do not submit sound if it could not be encoded (i.e. if too large)
        if (wavBuffer) {
            if (!skipUndo) {
                this.redoStack = [];
                if (this.undoStack.length >= UNDO_STACK_SIZE) {
                    this.undoStack.shift(); // Drop the first element off the array
                }
                this.undoStack.push(this.copyCurrentBuffer());
            }
            this.resetState(samples, sampleRate);
            this.props.vm.updateSoundBuffer(
                this.props.soundIndex,
                this.audioBufferPlayer.buffer,
                new Uint8Array(wavBuffer));

            return true; // Update succeeded
        }
        return false; // Update failed
    }
    handlePlay (playToEnd = false) {
        this.audioBufferPlayer.stop();
        this.audioBufferPlayer.play(
            this.state.trimStart || 0,
            (playToEnd === true) ? 1 : this.state.trimEnd || 1,
            this.handleUpdatePlayhead,
            this.handleStoppedPlaying);
    }
    handleStopPlaying () {
        this.audioBufferPlayer.stop();
        this.handleStoppedPlaying();
    }
    handleStoppedPlaying () {
        this.setState({playhead: null});
    }
    handleUpdatePlayhead (playhead) {
        this.setState({playhead});
    }
    handleChangeName (name) {
        this.props.vm.renameSound(this.props.soundIndex, name);
    }
    handleActivateTrim () {
        const {samples, sampleRate} = this.copyCurrentBuffer();
        const sampleCount = samples.length;
        const startIndex = Math.floor(this.state.trimStart * sampleCount);
        const endIndex = Math.floor(this.state.trimEnd * sampleCount);
        const firstPart = samples.slice(0, startIndex);
        const secondPart = samples.slice(endIndex, sampleCount);
        const newLength = firstPart.length + secondPart.length;
        let newSamples;
        if (newLength === 0) {
            newSamples = new Float32Array(1);
        } else {
            newSamples = new Float32Array(newLength);
            newSamples.set(firstPart, 0);
            newSamples.set(secondPart, firstPart.length);
        }
        this.submitNewSamples(newSamples, sampleRate);
        this.setState({
            trimStart: null,
            trimEnd: null
        });
    }
    handleUpdateTrim (trimStart, trimEnd) {
        this.setState({trimStart, trimEnd});
        this.handleStopPlaying();
    }
    effectFactory (name) {
        return () => this.handleEffect(name);
    }
    copyCurrentBuffer () {
        // Cannot reliably use props.samples because it gets detached by Firefox
        return {
            samples: this.audioBufferPlayer.buffer.getChannelData(0),
            sampleRate: this.audioBufferPlayer.buffer.sampleRate
        };
    }
    handleEffect (name) {
        const trimStart = this.state.trimStart === null ? 0.0 : this.state.trimStart;
        const trimEnd = this.state.trimEnd === null ? 1.0 : this.state.trimEnd;

        const effects = new AudioEffects(this.audioBufferPlayer.buffer, name,
            trimStart, trimEnd, this.impulseResponses);
        effects.process((renderedBuffer, adjustedTrimStart, adjustedTrimEnd) => {
            const samples = renderedBuffer.getChannelData(0);
            const sampleRate = renderedBuffer.sampleRate;
            const success = this.submitNewSamples(samples, sampleRate);
            if (success) {
                if (this.state.trimStart === null) {
                    this.handlePlay();
                } else {
                    this.setState({trimStart: adjustedTrimStart, trimEnd: adjustedTrimEnd}, this.handlePlay);
                }
            }
        });
    }
    handleUndo () {
        this.redoStack.push(this.copyCurrentBuffer());
        const {samples, sampleRate} = this.undoStack.pop();
        if (samples) {
            this.submitNewSamples(samples, sampleRate, true);
            this.handlePlay();
        }
    }
    handleRedo () {
        const {samples, sampleRate} = this.redoStack.pop();
        if (samples) {
            this.undoStack.push(this.copyCurrentBuffer());
            this.submitNewSamples(samples, sampleRate, true);
            this.handlePlay();
        }
    }
    handleCopy () {
        this.copy();
    }
    copy (callback) {
        const trimStart = this.state.trimStart === null ? 0.0 : this.state.trimStart;
        const trimEnd = this.state.trimEnd === null ? 1.0 : this.state.trimEnd;

        const trimStartSamples = trimStart * this.props.samples.length;
        const trimEndSamples = trimEnd * this.props.samples.length;

        const newCopyBuffer = this.copyCurrentBuffer();
        newCopyBuffer.samples = newCopyBuffer.samples.slice(trimStartSamples, trimEndSamples);

        this.setState({
            copyBuffer: newCopyBuffer
        }, callback);
    }
    handleCopyToNew () {
        this.copy(this.copyToNew);
    }
    copyToNew () {
        // this is largely copied (haha) from the record-modal container handleSubmit function
        WavEncoder.encode({
            sampleRate: this.state.copyBuffer.sampleRate,
            channelData: [this.state.copyBuffer.samples]
        }).then(wavBuffer => {
            const vmSound = {
                format: '',
                dataFormat: 'wav',
                rate: this.state.copyBuffer.sampleRate,
                sampleCount: this.state.copyBuffer.samples.length
            };

            // Create an asset from the encoded .wav and get resulting md5
            const storage = this.props.vm.runtime.storage;
            vmSound.asset = storage.createAsset(
                storage.AssetType.Sound,
                storage.DataFormat.WAV,
                new Uint8Array(wavBuffer),
                null,
                true // generate md5
            );
            vmSound.assetId = vmSound.asset.assetId;

            // update vmSound object with md5 property
            vmSound.md5 = `${vmSound.assetId}.${vmSound.dataFormat}`;
            // The VM will update the sound name to a fresh name
            vmSound.name = this.props.name;

            this.props.vm.addSound(vmSound).then(() => {
                // switch to the new sound here?
            });
        });
    }
    resampleBufferToRate (buffer, newRate) {
        return new Promise(resolve => {
            if (window.OfflineAudioContext) {
                const sampleRateRatio = newRate / buffer.sampleRate;
                const newLength = sampleRateRatio * buffer.samples.length;
                const offlineContext = new window.OfflineAudioContext(1, newLength, newRate);
                const source = offlineContext.createBufferSource();
                const audioBuffer = this.audioContext.createBuffer(1, buffer.samples.length, buffer.sampleRate);
                audioBuffer.getChannelData(0).set(buffer.samples);
                source.buffer = audioBuffer;
                source.connect(offlineContext.destination);
                source.start();
                offlineContext.startRendering();
                offlineContext.oncomplete = ({renderedBuffer}) => {
                    resolve({
                        samples: renderedBuffer.getChannelData(0),
                        sampleRate: newRate
                    });
                };
            }
        });
    }
    paste () {
        // If there's no selection, paste at the end of the sound
        if (this.state.trimStart === null) {
            const newLength = this.props.samples.length + this.state.copyBuffer.samples.length;
            const newSamples = new Float32Array(newLength);
            newSamples.set(this.props.samples, 0);
            newSamples.set(this.state.copyBuffer.samples, this.props.samples.length);
            this.submitNewSamples(newSamples, this.props.sampleRate, false);
        } else {
            // else replace the selection with the pasted sound
            const trimStartSamples = this.state.trimStart * this.props.samples.length;
            const trimEndSamples = this.state.trimEnd * this.props.samples.length;
            const firstPart = this.props.samples.slice(0, trimStartSamples);
            const lastPart = this.props.samples.slice(trimEndSamples);
            const newLength = firstPart.length + this.state.copyBuffer.samples.length + lastPart.length;
            const newSamples = new Float32Array(newLength);
            newSamples.set(firstPart, 0);
            newSamples.set(this.state.copyBuffer.samples, firstPart.length);
            newSamples.set(lastPart, firstPart.length + this.state.copyBuffer.samples.length);

            const trimStartSeconds = trimStartSamples / this.props.sampleRate;
            const trimEndSeconds = trimStartSeconds +
                (this.state.copyBuffer.samples.length / this.state.copyBuffer.sampleRate);
            const newDurationSeconds = newSamples.length / this.state.copyBuffer.sampleRate;
            const adjustedTrimStart = trimStartSeconds / newDurationSeconds;
            const adjustedTrimEnd = trimEndSeconds / newDurationSeconds;
            this.setState({
                trimStart: adjustedTrimStart,
                trimEnd: adjustedTrimEnd
            });

            this.submitNewSamples(newSamples, this.props.sampleRate, false);
        }

        this.handlePlay();
    }
    handlePaste () {
        if (this.state.copyBuffer.sampleRate === this.props.sampleRate) {
            this.paste();
        } else {
            log.warn('pasted audio sample rate does not match editor sample rate, resampling');
            this.resampleBufferToRate(this.state.copyBuffer, this.props.sampleRate).then(buffer => {
                this.setState({
                    copyBuffer: buffer
                }, this.paste);
            });
        }
    }
    render () {
        const {effectTypes} = AudioEffects;
        return (
            <SoundEditorComponent
                canPaste={this.state.copyBuffer !== null}
                canRedo={this.redoStack.length > 0}
                canUndo={this.undoStack.length > 0}
                chunkLevels={this.state.chunkLevels}
                name={this.props.name}
                playhead={this.state.playhead}
                trimEnd={this.state.trimEnd}
                trimStart={this.state.trimStart}
                onActivateTrim={this.handleActivateTrim}
                onAlien={this.effectFactory(effectTypes.ALIEN)}
                onChangeName={this.handleChangeName}
                onCopy={this.handleCopy}
                onCopyToNew={this.handleCopyToNew}
                onEcho={this.effectFactory(effectTypes.ECHO)}
                onFadeIn={this.effectFactory(effectTypes.FADEIN)}
                onFadeOut={this.effectFactory(effectTypes.FADEOUT)}
                onFaster={this.effectFactory(effectTypes.FASTER)}
                onLouder={this.effectFactory(effectTypes.LOUDER)}
                onMagic={this.effectFactory(effectTypes.MAGIC)}
                onMute={this.effectFactory(effectTypes.MUTE)}
                onPaste={this.handlePaste}
                onPlay={this.handlePlay}
                onRedo={this.handleRedo}
                onReverb={this.effectFactory(effectTypes.REVERB)}
                onReverse={this.effectFactory(effectTypes.REVERSE)}
                onRobot={this.effectFactory(effectTypes.ROBOT)}
                onSetTrim={this.handleUpdateTrim}
                onSlower={this.effectFactory(effectTypes.SLOWER)}
                onSofter={this.effectFactory(effectTypes.SOFTER)}
                onStop={this.handleStopPlaying}
                onUndo={this.handleUndo}
            />
        );
    }
}

SoundEditor.propTypes = {
    name: PropTypes.string.isRequired,
    sampleRate: PropTypes.number,
    samples: PropTypes.instanceOf(Float32Array),
    soundId: PropTypes.string,
    soundIndex: PropTypes.number,
    vm: PropTypes.instanceOf(VM).isRequired
};

const mapStateToProps = (state, {soundIndex}) => {
    const sprite = state.scratchGui.vm.editingTarget.sprite;
    // Make sure the sound index doesn't go out of range.
    const index = soundIndex < sprite.sounds.length ? soundIndex : sprite.sounds.length - 1;
    const sound = state.scratchGui.vm.editingTarget.sprite.sounds[index];
    const audioBuffer = state.scratchGui.vm.getSoundBuffer(index);
    return {
        soundId: sound.soundId,
        sampleRate: audioBuffer.sampleRate,
        samples: audioBuffer.getChannelData(0),
        name: sound.name,
        vm: state.scratchGui.vm
    };
};

export default connect(
    mapStateToProps
)(SoundEditor);
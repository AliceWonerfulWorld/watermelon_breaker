const ui = {
  canvas: document.querySelector("#sonarCanvas"),
  modeLabel: document.querySelector("#modeLabel"),
  guidanceText: document.querySelector("#guidanceText"),
  angleReadout: document.querySelector("#angleReadout"),
  stepsReadout: document.querySelector("#stepsReadout"),
  bpmReadout: document.querySelector("#bpmReadout"),
  motionReadout: document.querySelector("#motionReadout"),
  distanceInput: document.querySelector("#distanceInput"),
  distanceOutput: document.querySelector("#distanceOutput"),
  sensitivityInput: document.querySelector("#sensitivityInput"),
  sensitivityOutput: document.querySelector("#sensitivityOutput"),
  permissionButton: document.querySelector("#permissionButton"),
  lockButton: document.querySelector("#lockButton"),
  resetButton: document.querySelector("#resetButton"),
  voiceButton: document.querySelector("#voiceButton"),
  simulateStepButton: document.querySelector("#simulateStepButton"),
};

const state = {
  targetHeading: null,
  currentHeading: null,
  angleDelta: null,
  initialSteps: Number(ui.distanceInput.value),
  remainingSteps: Number(ui.distanceInput.value),
  locked: false,
  arrived: false,
  audioReady: false,
  sensorsReady: false,
  lastStepAt: 0,
  lastAccelMagnitude: null,
  filteredMotion: 0,
  motionSamples: 0,
  motionPeakArmed: true,
  stepSensitivity: Number(ui.sensitivityInput.value),
  voiceEnabled: true,
  lastSpokenAt: 0,
  lastSpokenKey: null,
  pulse: 0,
  bpm: 72,
};

let audioContext;
let masterGain;
let beatTimer;
let animationFrame;

const canvasContext = ui.canvas.getContext("2d");

function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function shortestDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getHeading(event) {
  if (typeof event.webkitCompassHeading === "number") {
    return normalizeDegrees(event.webkitCompassHeading);
  }

  if (typeof event.alpha === "number") {
    return normalizeDegrees(360 - event.alpha);
  }

  return null;
}

async function requestSensors() {
  const permissionRequests = [];

  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    permissionRequests.push(DeviceOrientationEvent.requestPermission());
  }

  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    permissionRequests.push(DeviceMotionEvent.requestPermission());
  }

  if (permissionRequests.length > 0) {
    const results = await Promise.all(permissionRequests);
    if (results.some((result) => result !== "granted")) {
      throw new Error("センサー利用が許可されませんでした。");
    }
  }

  window.addEventListener("deviceorientation", handleOrientation, true);
  window.addEventListener("devicemotion", handleMotion, true);
  state.sensorsReady = true;
}

function ensureAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("このブラウザはWeb Audio APIに対応していません。");
  }

  if (!audioContext) {
    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.28;
    masterGain.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    return audioContext.resume();
  }

  return Promise.resolve();
}

async function enableExperience() {
  if (state.audioReady && state.sensorsReady) return true;

  ui.permissionButton.disabled = true;
  ui.permissionButton.textContent = "有効化中...";

  try {
    await ensureAudio();
    await requestSensors();
    state.audioReady = true;
    ui.permissionButton.textContent = "有効化済み";
    ui.guidanceText.textContent = "スマホの先端をスイカに向けて、ターゲットロックを押してください。";
    startBeatLoop();
    return true;
  } catch (error) {
    ui.permissionButton.disabled = false;
    ui.permissionButton.textContent = "音声・センサーを有効化";
    ui.guidanceText.textContent = error.message || "有効化できませんでした。HTTPSまたはlocalhostで開いてください。";
    return false;
  }
}

function handleOrientation(event) {
  const heading = getHeading(event);
  if (heading === null) return;

  state.currentHeading = heading;
  if (state.locked) {
    state.angleDelta = shortestDelta(state.currentHeading, state.targetHeading);
    updateNavigation();
  } else {
    ui.angleReadout.textContent = `${Math.round(heading)}°`;
  }
}

function handleMotion(event) {
  const accel = event.accelerationIncludingGravity;
  if (!accel) return;

  const magnitude = Math.hypot(accel.x || 0, accel.y || 0, accel.z || 0);
  if (state.lastAccelMagnitude === null) {
    state.lastAccelMagnitude = magnitude;
    return;
  }

  const impulse = Math.abs(magnitude - state.lastAccelMagnitude);
  state.lastAccelMagnitude = magnitude * 0.22 + state.lastAccelMagnitude * 0.78;
  state.filteredMotion = state.filteredMotion * 0.82 + impulse * 0.18;
  state.motionSamples += 1;
  ui.motionReadout.textContent = state.filteredMotion.toFixed(1);

  if (!state.locked || state.arrived || state.motionSamples < 8) return;

  const threshold = 1.85 - (state.stepSensitivity - 1) * 0.28;
  const resetThreshold = threshold * 0.55;
  const now = Date.now();

  if (state.motionPeakArmed && state.filteredMotion > threshold && now - state.lastStepAt > 330) {
    registerStep();
    state.motionPeakArmed = false;
  }

  if (state.filteredMotion < resetThreshold) {
    state.motionPeakArmed = true;
  }
}

async function lockTarget() {
  if (!state.audioReady) {
    const enabled = await enableExperience();
    if (!enabled) return;
  }

  if (state.currentHeading === null) {
    ui.guidanceText.textContent = "方位センサー待機中です。スマホを少し動かしてから再度ロックしてください。";
    return;
  }

  state.targetHeading = state.currentHeading;
  state.angleDelta = 0;
  state.remainingSteps = state.initialSteps;
  state.locked = true;
  state.arrived = false;
  state.lastStepAt = 0;
  state.motionSamples = 0;
  state.motionPeakArmed = true;
  ui.modeLabel.textContent = "LOCKED";
  updateNavigation();
  playConfirm();
}

function resetRun() {
  state.targetHeading = null;
  state.angleDelta = null;
  state.remainingSteps = state.initialSteps;
  state.locked = false;
  state.arrived = false;
  state.bpm = 72;
  ui.modeLabel.textContent = "SETUP";
  ui.guidanceText.textContent = "スイカの方向へスマホの先端を向けて、ターゲットをロックしてください。";
  ui.angleReadout.textContent = state.currentHeading === null ? "--°" : `${Math.round(state.currentHeading)}°`;
  ui.stepsReadout.textContent = String(state.remainingSteps);
  ui.bpmReadout.textContent = "--";
  ui.motionReadout.textContent = state.filteredMotion > 0 ? state.filteredMotion.toFixed(1) : "--";
  state.lastSpokenAt = 0;
  state.lastSpokenKey = null;
  stopSpeaking();
  if (navigator.vibrate) navigator.vibrate(0);
}

function registerStep() {
  if (!state.locked || state.arrived) return;

  state.lastStepAt = Date.now();
  state.remainingSteps = Math.max(0, state.remainingSteps - 1);
  ui.stepsReadout.textContent = String(state.remainingSteps);
  playStepTick();
  announceDistance();

  if (state.remainingSteps === 0) {
    arrive();
  } else {
    updateNavigation();
  }
}

function updateNavigation() {
  const delta = state.angleDelta || 0;
  const absDelta = Math.abs(delta);
  const directionWord = delta > 0 ? "右" : "左";
  const distanceRatio = 1 - state.remainingSteps / state.initialSteps;

  let message;
  if (absDelta <= 15) {
    message = "正面です。ビートに乗ってまっすぐ進んでください。";
    state.bpm = 168 + distanceRatio * 28;
  } else if (absDelta <= 45) {
    message = `${directionWord}へ少し調整。テンポが上がる方向が正解です。`;
    state.bpm = 108 + (1 - (absDelta - 15) / 30) * 48 + distanceRatio * 18;
  } else {
    message = `${directionWord}へ大きく旋回。低い音の間はまだ迷子です。`;
    state.bpm = 54 + clamp((180 - absDelta) / 135, 0, 1) * 36;
  }

  ui.guidanceText.textContent = message;
  ui.angleReadout.textContent = `${Math.round(delta)}°`;
  ui.stepsReadout.textContent = String(state.remainingSteps);
  ui.bpmReadout.textContent = String(Math.round(state.bpm));
  announceNavigation(delta, absDelta);
}

function arrive() {
  state.arrived = true;
  state.bpm = 210;
  ui.modeLabel.textContent = "STRIKE";
  ui.guidanceText.textContent = "到着です。ファンファーレが鳴ったら振り下ろしてください。";
  ui.bpmReadout.textContent = "210";
  speak("止まって。そこで叩いてください。", "strike", { force: true });
  playFanfare();
  if (navigator.vibrate) {
    navigator.vibrate([180, 80, 180, 80, 420, 120, 420]);
  }
}

function speak(text, key, options = {}) {
  if (!state.voiceEnabled || !("speechSynthesis" in window)) return;

  const now = Date.now();
  const sameKey = key === state.lastSpokenKey;
  if (!options.force && sameKey && now - state.lastSpokenAt < 3200) return;
  if (!options.force && !sameKey && now - state.lastSpokenAt < 1200) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = 1.18;
  utterance.pitch = 1.05;
  utterance.volume = 1;

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  state.lastSpokenAt = now;
  state.lastSpokenKey = key;
}

function stopSpeaking() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

function announceNavigation(delta, absDelta) {
  if (!state.locked || state.arrived) return;

  if (state.remainingSteps <= 1 && absDelta <= 22) {
    speak("止まって。目の前です。", "stop");
    return;
  }

  if (absDelta <= 15) {
    speak("まっすぐ。", "straight");
    return;
  }

  if (absDelta <= 45) {
    speak(delta > 0 ? "少し右。" : "少し左。", delta > 0 ? "soft-right" : "soft-left");
    return;
  }

  speak(delta > 0 ? "もっと右。" : "もっと左。", delta > 0 ? "hard-right" : "hard-left");
}

function announceDistance() {
  if (state.arrived) return;

  if (state.remainingSteps === 3) {
    speak("あと三歩。", "three-left", { force: true });
  } else if (state.remainingSteps === 2) {
    speak("あと二歩。", "two-left", { force: true });
  } else if (state.remainingSteps === 1) {
    speak("あと一歩。", "one-left", { force: true });
  }
}

function playTone({ frequency, duration = 0.08, type = "sine", gain = 0.16, delay = 0 }) {
  if (!audioContext || !masterGain) return;

  const now = audioContext.currentTime + delay;
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(gain, now + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(envelope);
  envelope.connect(masterGain);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
}

function playBeat() {
  if (!state.audioReady || !state.locked) return;

  if (state.arrived) {
    playTone({ frequency: 784, duration: 0.06, type: "triangle", gain: 0.12 });
    return;
  }

  const absDelta = Math.abs(state.angleDelta || 180);
  const distancePitch = 1 + (1 - state.remainingSteps / state.initialSteps) * 0.45;

  if (absDelta <= 15) {
    playTone({ frequency: 440 * distancePitch, duration: 0.075, type: "triangle", gain: 0.18 });
    playTone({ frequency: 660 * distancePitch, duration: 0.045, type: "sine", gain: 0.08, delay: 0.055 });
  } else if (absDelta <= 45) {
    playTone({ frequency: 330 * distancePitch, duration: 0.08, type: "square", gain: 0.11 });
  } else {
    playTone({ frequency: 110 + clamp(180 - absDelta, 0, 135), duration: 0.14, type: "sawtooth", gain: 0.08 });
  }
}

function playStepTick() {
  playTone({ frequency: 520, duration: 0.035, type: "square", gain: 0.08 });
}

function playConfirm() {
  playTone({ frequency: 523.25, duration: 0.08, type: "triangle", gain: 0.14 });
  playTone({ frequency: 783.99, duration: 0.12, type: "triangle", gain: 0.14, delay: 0.09 });
  if (navigator.vibrate) navigator.vibrate(80);
}

function playFanfare() {
  [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
    playTone({ frequency, duration: 0.16, type: "triangle", gain: 0.18, delay: index * 0.13 });
  });
}

function startBeatLoop() {
  if (beatTimer) return;

  const tick = () => {
    playBeat();
    const interval = 60000 / clamp(state.bpm, 45, 220);
    beatTimer = window.setTimeout(tick, interval);
  };

  tick();
}

function drawSonar() {
  const rect = ui.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  if (ui.canvas.width !== Math.round(rect.width * dpr) || ui.canvas.height !== Math.round(rect.height * dpr)) {
    ui.canvas.width = Math.round(rect.width * dpr);
    ui.canvas.height = Math.round(rect.height * dpr);
  }

  const width = ui.canvas.width;
  const height = ui.canvas.height;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.36;
  const ctx = canvasContext;
  const absDelta = Math.abs(state.angleDelta || 0);
  const lockQuality = state.locked ? 1 - clamp(absDelta / 90, 0, 1) : 0.25;
  const accent = state.arrived ? "#ffd166" : `rgba(${Math.round(255 - lockQuality * 255)}, ${Math.round(92 + lockQuality * 116)}, ${Math.round(109 + lockQuality * 23)}, 1)`;

  state.pulse += state.locked ? 0.025 + clamp(state.bpm / 9000, 0, 0.03) : 0.012;
  ctx.clearRect(0, 0, width, height);

  ctx.save();
  ctx.translate(cx, cy);

  for (let ring = 0; ring < 4; ring += 1) {
    const ringPulse = (state.pulse + ring / 4) % 1;
    ctx.beginPath();
    ctx.arc(0, 0, radius * (0.35 + ringPulse * 0.9), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.18 * (1 - ringPulse)})`;
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3 * dpr;
  ctx.stroke();

  ctx.rotate(((state.angleDelta || 0) - 90) * Math.PI / 180);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(radius * 0.92, -radius * 0.18);
  ctx.lineTo(radius * 1.18, 0);
  ctx.lineTo(radius * 0.92, radius * 0.18);
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 32 * dpr;
  ctx.fill();

  ctx.restore();

  animationFrame = requestAnimationFrame(drawSonar);
}

ui.permissionButton.addEventListener("click", enableExperience);
ui.lockButton.addEventListener("click", lockTarget);
ui.resetButton.addEventListener("click", resetRun);
ui.voiceButton.addEventListener("click", () => {
  state.voiceEnabled = !state.voiceEnabled;
  ui.voiceButton.textContent = state.voiceEnabled ? "音声ガイド ON" : "音声ガイド OFF";
  ui.voiceButton.classList.toggle("is-on", state.voiceEnabled);
  ui.voiceButton.setAttribute("aria-pressed", String(state.voiceEnabled));
  if (state.voiceEnabled) {
    speak("音声ガイドを開始します。", "voice-on", { force: true });
  } else {
    stopSpeaking();
  }
});
ui.simulateStepButton.addEventListener("click", () => {
  ensureAudio().then(() => {
    state.audioReady = true;
    registerStep();
  });
});
ui.distanceInput.addEventListener("input", () => {
  state.initialSteps = Number(ui.distanceInput.value);
  if (!state.locked) {
    state.remainingSteps = state.initialSteps;
    ui.stepsReadout.textContent = String(state.remainingSteps);
  }
  ui.distanceOutput.textContent = `${state.initialSteps}歩`;
});
ui.sensitivityInput.addEventListener("input", () => {
  const labels = {
    1: "低い",
    2: "やや低い",
    3: "標準",
    4: "高い",
    5: "最高",
  };
  state.stepSensitivity = Number(ui.sensitivityInput.value);
  ui.sensitivityOutput.textContent = labels[state.stepSensitivity];
});

ui.stepsReadout.textContent = String(state.remainingSteps);
drawSonar();

window.addEventListener("pagehide", () => {
  if (beatTimer) window.clearTimeout(beatTimer);
  if (animationFrame) cancelAnimationFrame(animationFrame);
  if (navigator.vibrate) navigator.vibrate(0);
});

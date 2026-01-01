// sound.js

let audioContext;
let enterSoundBuffer;
let ticketSoundBuffer;
let loseSoundBuffer;

// Function to load all sounds
function loadAllSounds() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  const loadSound = (url) => {
    return fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to load sound: ${response.statusText}`);
        }
        return response.arrayBuffer();
      })
      .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer));
  };

  return Promise.all([
    loadSound('/sound/beswick-boys-rule.mp3').then(buffer => enterSoundBuffer = buffer),
    loadSound('/sound/win-single.mp3').then(buffer => ticketSoundBuffer = buffer),
    loadSound('/sound/lose-single.mp3').then(buffer => loseSoundBuffer = buffer)
  ]).then(() => {
    console.log('All sounds loaded successfully');
  }).catch(error => {
    console.error('Error loading sounds:', error);
  });
}

// Function to play a sound buffer
function playSound(soundBuffer, playbackRate = 1.0) {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  const source = audioContext.createBufferSource();
  source.buffer = soundBuffer;
  source.playbackRate.value = playbackRate;

  source.connect(audioContext.destination);
  source.start(0);

  return new Promise((resolve, reject) => {
    source.onended = () => {
      resolve();
    };

    source.onerror = (error) => {
      console.error('Audio playback error:', error);
      reject(error);
    };
  });
}

// Function to play the 'enter' sound
function playEnterSound() {
  if (enterSoundBuffer) {
    return playSound(enterSoundBuffer);
  } else {
    return Promise.reject('Enter sound not loaded');
  }
}

// Function to play the 'ticket' sound
function playTicketSound(playbackRate = 1.0) {
  if (ticketSoundBuffer) {
    return playSound(ticketSoundBuffer, playbackRate);
  } else {
    return Promise.reject('Ticket sound not loaded');
  }
}

// Function to play the 'lose' sound
function playLoseSound(playbackRate = 1.0) {
  if (loseSoundBuffer) {
    return playSound(loseSoundBuffer, playbackRate);
  } else {
    return Promise.reject('Lose sound not loaded');
  }
}

export { loadAllSounds, playEnterSound, playTicketSound, playLoseSound };
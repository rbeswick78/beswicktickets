// dotMatrix.js

import { charPatterns, digitPatterns } from './pattern.js';

// Function to create a dot matrix display for given text
function createDotMatrix(text, isNumber = false, className = '') {
  const patterns = isNumber ? digitPatterns : charPatterns;
  const container = document.createElement('div');
  container.className = `dot-matrix ${className}`.trim();

  text.split('').forEach((char) => {
    const upperChar = char.toUpperCase();
    const charPattern = patterns[upperChar] || patterns[' '];
    const charDiv = document.createElement('div');
    charDiv.className = 'dot-matrix-char';

    charPattern.forEach((dot) => {
      const dotDiv = document.createElement('div');
      dotDiv.className = `dot-matrix-dot ${dot ? 'dot-on' : 'dot-off'}`;
      charDiv.appendChild(dotDiv);
    });

    container.appendChild(charDiv);
  });

  return container;
}

export { createDotMatrix };
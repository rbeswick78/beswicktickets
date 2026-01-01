const userColorMap = {};
const possibleColors = [
  '#f44336', // red
  '#2196f3', // blue
  '#4caf50', // green
  '#ff9800', // orange
  '#9c27b0', // purple
  '#e91e63', // pink
];

function getOrAssignColor(userId) {
  if (!userColorMap[userId]) {
    const usedColors = new Set(Object.values(userColorMap));
    const availableColor =
      possibleColors.find((color) => !usedColors.has(color)) ||
      possibleColors[Object.keys(userColorMap).length % possibleColors.length];

    userColorMap[userId] = availableColor;
  }
  return userColorMap[userId];
}

function removeUserColor(userId) {
  delete userColorMap[userId];
}

module.exports = {
  getOrAssignColor,
  removeUserColor
};
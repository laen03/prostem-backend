// utils/nameParser.js

function getFullNameFromToken(decodedTokenName) {
    const parts = decodedTokenName.trim().split(/\s+/);
    let name = "";
    let lastName1 = "";
    let lastName2 = "";
  
    if (parts.length === 1) {
      name = parts[0];
    } else if (parts.length === 2) {
      [name, lastName1] = parts;
    } else if (parts.length === 3) {
      [name, lastName1, lastName2] = parts;
    } else {
      // Assume the name is everything except the last two parts
      name = parts.slice(0, -2).join(" ");
      lastName1 = parts[parts.length - 2];
      lastName2 = parts[parts.length - 1];
    }
  
    return { name, lastName1, lastName2 };
  }
  
  module.exports = { getFullNameFromToken };
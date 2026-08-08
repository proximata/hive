#!/usr/bin/env node
// Simple asciicast to SVG converter for README embedding

const fs = require('fs');
const path = require('path');

const castFile = process.argv[2];
const svgFile = process.argv[3] || castFile.replace('.cast', '.svg');
const maxFrames = parseInt(process.argv[4]) || 50;

if (!castFile) {
  console.error('Usage: cast-to-svg.js <cast-file> [svg-file] [max-frames]');
  process.exit(1);
}

const content = fs.readFileSync(castFile, 'utf-8');
const lines = content.trim().split('\n');
const header = JSON.parse(lines[0]);
const frames = lines.slice(1).map(l => JSON.parse(l));

const width = header.width || 80;
const height = header.height || 24;
const charWidth = 8;
const charHeight = 16;
const padding = 20;

const svgWidth = width * charWidth + padding * 2;
const svgHeight = height * charHeight + padding * 2;

let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="#1e1e1e"/>
  <style>
    .terminal-font { font-family: 'Monospace', monospace; font-size: ${charHeight}px; fill: #d4d4d4; }
    .cursor { fill: #ffffff; animation: blink 1s infinite; }
    @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
  </style>
`;

let y = padding;
const frame = frames[Math.min(frames.length - 1, maxFrames)];
if (frame[2] === 'o') {
  const text = frame[3].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const textLines = text.split('\n');
  textLines.forEach((line, i) => {
    if (i < height) {
      svg += `  <text x="${padding}" y="${y + i * charHeight}" class="terminal-font">${escapeXml(line)}</text>\n`;
    }
  });
}

svg += '</svg>';
fs.writeFileSync(svgFile, svg);
console.log(`SVG saved to ${svgFile}`);

function escapeXml(str) {
  return str.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, '&apos;');
}

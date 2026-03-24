#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== ANSI Editor Setup ==="

mkdir -p fonts
BASE="https://raw.githubusercontent.com/blocktronics/moebius/master/app/fonts/ibm"

echo "Downloading IBM VGA 8x16 font..."
curl -sL "$BASE/CP437.F16" -o "fonts/CP437.F16"
ln -sf "CP437.F16" "fonts/IBM VGA.F16"
echo "  -> fonts/CP437.F16 ($(wc -c < fonts/CP437.F16) bytes)"

echo "Downloading IBM VGA50 8x8 font..."
curl -sL "$BASE/CP437.F08" -o "fonts/CP437.F08"
ln -sf "CP437.F08" "fonts/IBM VGA50.F08"
echo "  -> fonts/CP437.F08 ($(wc -c < fonts/CP437.F08) bytes)"

echo "Downloading IBM EGA 8x14 font..."
curl -sL "$BASE/CP437.F14" -o "fonts/CP437.F14"
ln -sf "CP437.F14" "fonts/IBM EGA.F14"
echo "  -> fonts/CP437.F14 ($(wc -c < fonts/CP437.F14) bytes)"

echo "Installing npm dependencies..."
npm install

echo "Building..."
npm run build

echo "=== Setup complete ==="

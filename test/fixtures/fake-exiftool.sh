#!/usr/bin/env bash
# fake exiftool for offline e2e — impersonates the ExifTool CLI so the REAL
# shipped exif.sh (its jq mapping + OVERCAST_EXIFTOOL_CMD override) runs without a
# real exiftool. `-ver` → a version (doctor); otherwise (`-n -json <file>`) → one
# ExifTool-style object with GPS + an editor Software tag + serial/lens.
set -uo pipefail
case "${1:-}" in
  -ver) echo "12.76"; exit 0 ;;
esac
printf '%s\n' '[{"SourceFile":"fake.jpg","Make":"TestCam","Model":"X100","Software":"Adobe Photoshop 24.0","SerialNumber":"SN-FAKE-1","LensModel":"TestLens 50mm","GPSLatitude":1.5,"GPSLongitude":2.5,"DateTimeOriginal":"2024:01:01 00:00:00","MIMEType":"image/jpeg","ImageWidth":100,"ImageHeight":100}]'

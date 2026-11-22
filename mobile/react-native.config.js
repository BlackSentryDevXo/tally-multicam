// The ML Kit barcode scanner is only for Android (VisionCamera's built-in QR output is iOS-only); keep it out of iOS.
module.exports = {
  dependencies: {
    'react-native-vision-camera-barcode-scanner': { platforms: { ios: null } },
  },
};

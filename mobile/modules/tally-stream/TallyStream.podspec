require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "TallyStream"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/"
  s.license      = package["license"]
  s.authors      = "Tally"
  s.platforms    = { :ios => "16.4" }
  s.source       = { :path => "." }

  s.source_files = [
    # Implementation (Swift) + libsrt C facade + ObjC try/catch shim
    "ios/**/*.{swift}",
    "ios/*.{h,c,m}",
  ]
  # Public so Swift (same module) can call them; neither includes libsrt headers.
  s.public_header_files = ["ios/TallySrt.h", "ios/TallyObjC.h"]
  s.frameworks = ["AVFoundation", "VideoToolbox", "CoreMedia", "CoreVideo", "ImageIO"]
  s.libraries = ["c++"]

  # SRT 1.5.7 static xcframework (HaishinKit/libsrt-xcframework v1.5.7, iOS slices only).
  # It links against OpenSSL 3 (libcrypto), provided by OpenSSL-Universal.
  s.vendored_frameworks = "ios/Frameworks/libsrt.xcframework"
  s.dependency "OpenSSL-Universal", "~> 3.3"

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/ios/Frameworks/libsrt.xcframework/ios-arm64/Headers/libsrt\"",
  }

  load "nitrogen/generated/ios/TallyStream+autolinking.rb"
  add_nitrogen_files(s)

  s.dependency "VisionCamera"
  s.dependency "React-jsi"
  s.dependency "React-callinvoker"
  install_modules_dependencies(s)
end

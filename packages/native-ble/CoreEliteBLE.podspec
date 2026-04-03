require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "CoreEliteBLE"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/your-org/core-elite"
  s.license      = "MIT"
  s.authors      = { "Core Elite" => "engineering@coreelite.app" }
  s.platforms    = { :ios => "14.0" }

  s.source       = { :path => "." }

  s.source_files = [
    "ios/**/*.{h,m,mm}",
    "cpp/**/*.{h,cpp}",
  ]

  # C++17 required for std::mutex, std::queue, std::vector NRVO guarantees
  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD"        => "c++17",
    "CLANG_CXX_LIBRARY"                  => "libc++",
    "OTHER_CPLUSPLUSFLAGS"               => "-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1",
    "HEADER_SEARCH_PATHS"                =>
      "$(PODS_ROOT)/boost " \
      "$(PODS_ROOT)/RCT-Folly " \
      "$(PODS_ROOT)/Headers/Public/React-Core",
  }

  # New Architecture (TurboModules + Codegen)
  install_modules_dependencies(s)

  s.dependency "React-Core"
  s.dependency "React-RCTBlobManager"
  s.dependency "ReactCommon/turbomodule/core"

  # CoreBluetooth framework — linked automatically on iOS 14+
  s.framework = "CoreBluetooth"
end

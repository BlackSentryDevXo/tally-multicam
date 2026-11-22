//
//  HybridLiveStreamFactory.swift
//  TallyStream
//

import NitroModules
import VisionCamera

final class HybridLiveStreamFactory: HybridLiveStreamFactorySpec {
  func createStreamer() throws -> any HybridLiveStreamerSpec {
    return HybridLiveStreamer()
  }

  func createStreamOutput(streamer: any HybridLiveStreamerSpec, targetWidth: Double, targetHeight: Double) throws
    -> any HybridCameraOutputSpec
  {
    guard let streamer = streamer as? HybridLiveStreamer else {
      throw RuntimeError.error(withMessage: "createStreamOutput: `streamer` must come from createStreamer()")
    }
    return HybridLiveStreamOutput(streamer: streamer, targetWidth: targetWidth, targetHeight: targetHeight)
  }
}

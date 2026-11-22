//
//  TSMuxer.swift
//  TallyStream
//
//  Minimal MPEG-TS muxer for a single H.264 video elementary stream
//  (what SRT/MediaMTX/OBS expect). No B-frames, so DTS == PTS.
//

import Foundation

final class TSMuxer {
  static let packetSize = 188
  private let pmtPid: UInt16 = 0x1000
  private let videoPid: UInt16 = 0x0100
  private var continuity: [UInt16: UInt8] = [:]
  private var sentTables = false

  /// PTS is emitted this far after PCR so decoders have a little buffer headroom.
  private let ptsOffset90k: UInt64 = 9_000 // 100 ms

  func reset() {
    continuity.removeAll()
    sentTables = false
  }

  /// Muxes one Annex-B access unit into concatenated 188-byte TS packets.
  /// `pts90k` is the presentation time in 90 kHz units (monotonic).
  func mux(accessUnit: Data, pts90k: UInt64, isKeyframe: Bool) -> Data {
    var out = Data()
    out.reserveCapacity((accessUnit.count / 170 + 4) * TSMuxer.packetSize)
    if isKeyframe || !sentTables {
      out.append(patPacket())
      out.append(pmtPacket())
      sentTables = true
    }

    let pts = (pts90k + ptsOffset90k) & 0x1_FFFF_FFFF
    var pes = Data(capacity: accessUnit.count + 14)
    pes.append(contentsOf: [0x00, 0x00, 0x01, 0xE0, 0x00, 0x00]) // video stream, unbounded length
    pes.append(contentsOf: [0x84, 0x80, 0x05]) // marker+data_alignment, PTS only, header length 5
    pes.append(contentsOf: TSMuxer.encodeTimestamp(pts, marker: 0x20))
    pes.append(accessUnit)

    pes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let bytes = raw.bindMemory(to: UInt8.self)
      var offset = 0
      var first = true
      while offset < bytes.count {
        var adaptation: [UInt8] = []
        if first {
          // PCR on the first packet of every frame, plus random-access flag on keyframes.
          let flags: UInt8 = 0x10 | (isKeyframe ? 0x40 : 0x00)
          adaptation = [flags] + TSMuxer.encodePCR(pts90k & 0x1_FFFF_FFFF)
        }
        var adaptationBytes = adaptation.isEmpty ? 0 : 1 + adaptation.count
        var payloadCapacity = 184 - adaptationBytes
        let remaining = bytes.count - offset
        if remaining < payloadCapacity {
          // Pad the final packet with adaptation-field stuffing.
          let stuffing = payloadCapacity - remaining
          if adaptation.isEmpty {
            adaptation = stuffing == 1 ? [] : [0x00] + [UInt8](repeating: 0xFF, count: stuffing - 2)
            adaptationBytes = stuffing
          } else {
            adaptation += [UInt8](repeating: 0xFF, count: stuffing)
            adaptationBytes += stuffing
          }
          payloadCapacity = remaining
        }

        var packet = [UInt8](repeating: 0, count: 4)
        packet[0] = 0x47
        packet[1] = (first ? 0x40 : 0x00) | UInt8((videoPid >> 8) & 0x1F)
        packet[2] = UInt8(videoPid & 0xFF)
        packet[3] = (adaptationBytes > 0 ? 0x30 : 0x10) | nextContinuity(videoPid)
        if adaptationBytes > 0 {
          packet.append(UInt8(adaptationBytes - 1))
          packet.append(contentsOf: adaptation)
        }
        packet.append(contentsOf: bytes[offset..<(offset + payloadCapacity)])
        assert(packet.count == TSMuxer.packetSize)
        out.append(contentsOf: packet)
        offset += payloadCapacity
        first = false
      }
    }
    return out
  }

  // MARK: - PSI

  private func patPacket() -> Data {
    var section: [UInt8] = [
      0x00,  // table_id: PAT
      0xB0, 0x0D,  // section_syntax_indicator + section_length 13
      0x00, 0x01,  // transport_stream_id
      0xC1,  // version 0, current_next 1
      0x00, 0x00,  // section / last section number
      0x00, 0x01,  // program_number 1
      0xE0 | UInt8((pmtPid >> 8) & 0x1F), UInt8(pmtPid & 0xFF),
    ]
    section += TSMuxer.crc32(section)
    return psiPacket(pid: 0x0000, section: section)
  }

  private func pmtPacket() -> Data {
    var section: [UInt8] = [
      0x02,  // table_id: PMT
      0xB0, 0x12,  // section_length 18
      0x00, 0x01,  // program_number
      0xC1,
      0x00, 0x00,
      0xE0 | UInt8((videoPid >> 8) & 0x1F), UInt8(videoPid & 0xFF),  // PCR PID
      0xF0, 0x00,  // program_info_length 0
      0x1B,  // stream_type: H.264
      0xE0 | UInt8((videoPid >> 8) & 0x1F), UInt8(videoPid & 0xFF),
      0xF0, 0x00,  // ES_info_length 0
    ]
    section += TSMuxer.crc32(section)
    return psiPacket(pid: pmtPid, section: section)
  }

  private func psiPacket(pid: UInt16, section: [UInt8]) -> Data {
    var packet: [UInt8] = [
      0x47,
      0x40 | UInt8((pid >> 8) & 0x1F),
      UInt8(pid & 0xFF),
      0x10 | nextContinuity(pid),
      0x00,  // pointer_field
    ]
    packet += section
    packet += [UInt8](repeating: 0xFF, count: TSMuxer.packetSize - packet.count)
    return Data(packet)
  }

  private func nextContinuity(_ pid: UInt16) -> UInt8 {
    let value = continuity[pid] ?? 0
    continuity[pid] = (value + 1) & 0x0F
    return value
  }

  // MARK: - Encoding helpers (internal for tests)

  static func encodeTimestamp(_ ts: UInt64, marker: UInt8) -> [UInt8] {
    return [
      marker | UInt8((ts >> 29) & 0x0E) | 0x01,
      UInt8((ts >> 22) & 0xFF),
      UInt8((ts >> 14) & 0xFE) | 0x01,
      UInt8((ts >> 7) & 0xFF),
      UInt8((ts << 1) & 0xFE) | 0x01,
    ]
  }

  static func encodePCR(_ base: UInt64) -> [UInt8] {
    return [
      UInt8((base >> 25) & 0xFF),
      UInt8((base >> 17) & 0xFF),
      UInt8((base >> 9) & 0xFF),
      UInt8((base >> 1) & 0xFF),
      UInt8((base & 0x01) << 7) | 0x7E,  // 6 reserved bits + extension high bit 0
      0x00,
    ]
  }

  /// CRC-32/MPEG-2 (poly 0x04C11DB7, init 0xFFFFFFFF, no reflection, no final xor).
  static func crc32(_ bytes: [UInt8]) -> [UInt8] {
    var crc: UInt32 = 0xFFFF_FFFF
    for byte in bytes {
      crc ^= UInt32(byte) << 24
      for _ in 0..<8 {
        crc = (crc & 0x8000_0000) != 0 ? (crc << 1) ^ 0x04C1_1DB7 : crc << 1
      }
    }
    return [UInt8(crc >> 24), UInt8((crc >> 16) & 0xFF), UInt8((crc >> 8) & 0xFF), UInt8(crc & 0xFF)]
  }
}

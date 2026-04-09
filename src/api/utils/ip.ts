// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { BlockList, isIPv4 } from 'node:net';

/**
 * Normalize an IP address: strip IPv4-mapped IPv6 prefixes so that
 * `::ffff:1.2.3.4` and `::ffff:c0a8:0101` both resolve to their IPv4 form.
 */
function normalizeIp(ip: string): string {
  // Handle textual ::ffff:1.2.3.4 form
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const tail = ip.slice(7);
    // If the tail is dotted-decimal IPv4, use it directly
    if (isIPv4(tail)) return tail;
  }
  return ip;
}

/**
 * Check whether an IP address is permitted by a CIDR allowlist.
 * An empty allowlist means "allow all".
 */
export function isIpAllowed(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true;

  const list = new BlockList();
  for (const cidr of cidrs) {
    const slash = cidr.lastIndexOf('/');
    if (slash === -1) continue;
    const addr = cidr.slice(0, slash);
    const prefix = parseInt(cidr.slice(slash + 1), 10);
    const type = addr.includes(':') ? 'ipv6' as const : 'ipv4' as const;
    list.addSubnet(addr, prefix, type);
  }

  const normalized = normalizeIp(ip);
  const addrType = isIPv4(normalized) ? 'ipv4' as const : 'ipv6' as const;
  return list.check(normalized, addrType);
}

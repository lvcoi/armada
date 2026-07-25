// Working out which address to tell people to type into their phone.

import os from 'node:os';

// Docker bridges, VPN tunnels and hypervisor adapters all present perfectly valid IPv4
// addresses that no phone on the wifi can reach. Filter them out by interface name.
const VIRTUAL = /^(docker|br-|veth|virbr|tun|tap|utun|vmnet|vboxnet|zt|wg|tailscale|ham|Loopback|vEthernet)/i;

const isPrivate = (ip) =>
  /^192\.168\./.test(ip) ||
  /^10\./.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

const isLinkLocal = (ip) => /^169\.254\./.test(ip);

/**
 * Candidate LAN addresses, best first. Home-router ranges win; link-local loses.
 * Returns [{ name, address }].
 */
export function lanAddresses() {
  const out = [];

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      const family = typeof a.family === 'string' ? a.family : `IPv${a.family}`;
      if (family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address });
    }
  }

  return out.sort((x, y) => score(y.address) - score(x.address));
}

function score(ip) {
  if (isLinkLocal(ip)) return 0;
  if (isPrivate(ip)) return 2;
  return 1;
}

export function banner(port, qr) {
  const candidates = lanAddresses();
  const lines = [
    '',
    '  [1mArmada[0m — Battleship on the home wifi',
    '',
    `  On this device:  http://localhost:${port}`,
  ];

  if (!candidates.length) {
    lines.push(
      '',
      '  [33mNo LAN address found.[0m Are you connected to wifi?',
      '  Other devices will not be able to join until you are.',
    );
  } else {
    lines.push(`  On your phone:   [1mhttp://${candidates[0].address}:${port}[0m`);
    // A silently wrong guess is worse than a short list, so show the runners-up.
    if (candidates.length > 1) {
      lines.push('', '  If that one does not work, try:');
      for (const c of candidates.slice(1, 4)) {
        lines.push(`    http://${c.address}:${port}   (${c.name})`);
      }
    }
  }

  if (qr) lines.push('', qr);
  lines.push('  Everyone has to be on the same wifi network.', '');
  return lines.join('\n');
}

/**
 * Structured output parsers for network OS show commands.
 *
 * Supports Cisco NX-OS and Dell OS10 / SONiC platforms.
 * Each parser accepts the raw CLI output string and a platform hint,
 * and returns a structured JSON object (or null if parsing fails).
 */

export type ParserPlatform = 'nxos' | 'dell-os10' | 'os10' | 'sonic' | 'auto';

/** Normalize platform aliases so callers can pass 'os10' or 'dell-os10' interchangeably. */
function normalizePlatform(platform: string): ParserPlatform {
  return platform === 'os10' ? 'dell-os10' : (platform as ParserPlatform);
}

// ── BGP Summary ──────────────────────────────────────────────────────────────

export interface BgpPeer {
  neighbor: string;
  version: string;
  as: string;
  msg_rcvd: string;
  msg_sent: string;
  tbl_ver: string;
  in_q: string;
  out_q: string;
  up_down: string;
  state_pfx_rcvd: string;
}

export interface BgpSummaryResult {
  router_id?: string;
  local_as?: string;
  peers: BgpPeer[];
}

/**
 * Parse `show ip bgp summary` output.
 *
 * NX-OS example peer line:
 *   10.0.0.1        4 65001     100     200    0    0 00:01:02        5
 *
 * Dell OS10 / SONiC peer line (FRR-style):
 *   BGP neighbor is 10.0.0.1, remote AS 65001, local AS 65000, ...
 *   ...
 *   Neighbor        V         AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd
 *   10.0.0.1        4      65001     100     200        1    0    0 00:01:02            5
 */
export function parseShowIpBgpSummary(
  output: string,
  _platform: string
): BgpSummaryResult | null {
  const lines = output.split('\n');
  const result: BgpSummaryResult = { peers: [] };

  // Extract router-id and local AS
  const routerIdMatch = output.match(/BGP router identifier\s+([\d.]+),\s*local AS number\s+(\d+)/i);
  if (routerIdMatch) {
    result.router_id = routerIdMatch[1];
    result.local_as = routerIdMatch[2];
  }

  // Find the header line to locate the table
  const headerIdx = lines.findIndex((l) =>
    /Neighbor\s+V\s+AS\s+MsgRcvd/i.test(l)
  );

  const peerLineRe =
    /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

  const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const m = peerLineRe.exec(lines[i].trim());
    if (m) {
      result.peers.push({
        neighbor: m[1],
        version: m[2],
        as: m[3],
        msg_rcvd: m[4],
        msg_sent: m[5],
        tbl_ver: m[6],
        in_q: m[7],
        out_q: m[8],
        up_down: m[9],
        state_pfx_rcvd: m[10],
      });
    }
  }

  return result.peers.length > 0 || result.router_id ? result : null;
}

// ── Interface Status ─────────────────────────────────────────────────────────

export interface InterfaceStatus {
  interface: string;
  name?: string;
  status: string;
  vlan?: string;
  duplex?: string;
  speed?: string;
  type?: string;
}

export interface InterfaceStatusResult {
  interfaces: InterfaceStatus[];
}

/**
 * Parse `show interface status` output.
 *
 * NX-OS example:
 *   Port          Name               Status    Vlan      Duplex  Speed   Type
 *   Eth1/1        uplink             connected trunk     full    10G     10Gbase-SR
 *
 * Dell OS10 example:
 *   Interface    Description     Oper-State  AutoNeg  Speed     Duplex
 *   ethernet1/1/1  --            up          true     10000     full
 */
export function parseShowInterfaceStatus(
  output: string,
  _platform: string
): InterfaceStatusResult | null {
  const lines = output.split('\n');
  const interfaces: InterfaceStatus[] = [];

  // NX-OS style: Port + Name + Status + Vlan + Duplex + Speed + Type
  const nxosHeaderIdx = lines.findIndex((l) =>
    /Port\s+Name\s+Status\s+Vlan/i.test(l)
  );

  if (nxosHeaderIdx >= 0) {
    const nxosPeerRe =
      /^([\w/.-]+)\s+(.*?)\s{2,}(connected|notconnect|disabled|err-disabled|sfpAbsent)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i;
    for (let i = nxosHeaderIdx + 2; i < lines.length; i++) {
      const m = nxosPeerRe.exec(lines[i]);
      if (m) {
        interfaces.push({
          interface: m[1],
          name: m[2].trim() || undefined,
          status: m[3],
          vlan: m[4],
          duplex: m[5],
          speed: m[6],
          type: m[7],
        });
      }
    }
    if (interfaces.length > 0) return { interfaces };
  }

  // Dell OS10 / SONiC style: Interface + Description + Oper-State + ...
  const os10HeaderIdx = lines.findIndex((l) =>
    /Interface\s+Description\s+Oper[-\s]State/i.test(l)
  );

  if (os10HeaderIdx >= 0) {
    const os10Re =
      /^([\w/.-]+)\s+(.*?)\s{2,}(up|down|disabled)\s+(\S+)\s+(\S+)\s+(\S+)/i;
    for (let i = os10HeaderIdx + 1; i < lines.length; i++) {
      const m = os10Re.exec(lines[i]);
      if (m) {
        interfaces.push({
          interface: m[1],
          name: m[2].trim() || undefined,
          status: m[3],
          duplex: m[6],
          speed: m[5],
        });
      }
    }
    if (interfaces.length > 0) return { interfaces };
  }

  return interfaces.length > 0 ? { interfaces } : null;
}

// ── LLDP Neighbors ───────────────────────────────────────────────────────────

export interface LldpNeighbor {
  local_interface: string;
  chassis_id: string;
  port_id: string;
  system_name?: string;
  hold_time?: string;
}

export interface LldpNeighborsResult {
  neighbors: LldpNeighbor[];
}

/**
 * Parse `show lldp neighbors` output.
 *
 * NX-OS example:
 *   Capability codes:  (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
 *   (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other
 *   Device ID        Local Intf      Hold-time  Capability  Port ID
 *   neighbor-sw      Eth1/1          120        B, R        Eth0/1
 *
 * Dell OS10 example:
 *   Local Interface   Chassis-id         Remote Port-id     System Name   Hold-time
 *   ethernet1/1/1     00:11:22:33:44:55  ethernet1/1/2      neighbor-sw   120
 */
export function parseShowLldpNeighbors(
  output: string,
  _platform: string
): LldpNeighborsResult | null {
  const lines = output.split('\n');
  const neighbors: LldpNeighbor[] = [];

  // NX-OS style: Device ID + Local Intf + Hold-time + Capability + Port ID
  const nxosHeaderIdx = lines.findIndex((l) =>
    /Device ID\s+Local Intf\s+Hold-time/i.test(l)
  );

  if (nxosHeaderIdx >= 0) {
    const nxosRe =
      /^(\S+)\s+([\w/.-]+)\s+(\d+)\s+[\w,\s]*?\s+([\w/.-]+)\s*$/;
    for (let i = nxosHeaderIdx + 1; i < lines.length; i++) {
      const m = nxosRe.exec(lines[i].trim());
      if (m) {
        neighbors.push({
          local_interface: m[2],
          chassis_id: m[1],
          port_id: m[4],
          hold_time: m[3],
        });
      }
    }
    if (neighbors.length > 0) return { neighbors };
  }

  // Dell OS10 style: Local Interface + Chassis-id + Remote Port-id + System Name + Hold-time
  const os10HeaderIdx = lines.findIndex((l) =>
    /Local Interface\s+Chassis[-\s]id\s+Remote Port/i.test(l)
  );

  if (os10HeaderIdx >= 0) {
    const os10Re =
      /^([\w/.-]+)\s+([\w:.-]+)\s+([\w/.-]+)\s+(\S+)\s+(\d+)\s*$/;
    for (let i = os10HeaderIdx + 1; i < lines.length; i++) {
      const m = os10Re.exec(lines[i].trim());
      if (m) {
        neighbors.push({
          local_interface: m[1],
          chassis_id: m[2],
          port_id: m[3],
          system_name: m[4],
          hold_time: m[5],
        });
      }
    }
    if (neighbors.length > 0) return { neighbors };
  }

  return neighbors.length > 0 ? { neighbors } : null;
}

// ── Show Version ─────────────────────────────────────────────────────────────

export interface VersionResult {
  model?: string;
  firmware?: string;
  os_version?: string;
  uptime?: string;
  serial?: string;
  hostname?: string;
}

/**
 * Parse `show version` output.
 *
 * NX-OS example snippets:
 *   Cisco Nexus Operating System (NX-OS) Software
 *   BIOS: version 08.35
 *   kickstart: version 7.0(3)I7(9)
 *   system:    version 7.0(3)I7(9)
 *   Hardware
 *     cisco Nexus 9332C Chassis
 *   Kernel uptime is 10 day(s), 3 hour(s), 22 minute(s), 5 second(s)
 *
 * Dell OS10 / SONiC example:
 *   Dell EMC Networking OS10 Enterprise
 *   Software Version: 10.5.3.4
 *   System Type:      S5248F-ON
 *   Uptime:           0 day(s), 2 hour(s), 10 minute(s)
 */
export function parseShowVersion(
  output: string,
  _platform: string
): VersionResult | null {
  const result: VersionResult = {};

  // NX-OS
  const nxosSysVer = output.match(/system:\s+version\s+(\S+)/i);
  if (nxosSysVer) result.os_version = nxosSysVer[1];

  const nxosKickstart = output.match(/kickstart:\s+version\s+(\S+)/i);
  if (nxosKickstart) result.firmware = nxosKickstart[1];

  // NX-OS chassis line: "  cisco Nexus 9332C Chassis" — model is 2 tokens after "cisco Nexus"
  // Avoid matching "Nexus Operating System" (the software header line).
  const nxosChassis = output.match(/^\s*cisco\s+Nexus\s+((?!Operating)[\w-]+)/im);
  if (nxosChassis) {
    result.model = `Nexus ${nxosChassis[1]}`;
  }

  const nxosUptime = output.match(/Kernel uptime is\s+(.+)/i);
  if (nxosUptime) result.uptime = nxosUptime[1].trim();

  // Dell OS10 / SONiC
  const dellSoftwareVer = output.match(/Software Version:\s*(\S+)/i);
  if (dellSoftwareVer) result.os_version = result.os_version ?? dellSoftwareVer[1];

  const dellSystemType = output.match(/System Type:\s*(\S+)/i);
  if (dellSystemType) result.model = result.model ?? dellSystemType[1];

  const dellUptime = output.match(/Uptime:\s*(.+)/i);
  if (dellUptime) result.uptime = result.uptime ?? dellUptime[1].trim();

  // Shared: hostname
  const hostname = output.match(/[Hh]ostname[:\s]+(\S+)/);
  if (hostname) result.hostname = hostname[1];

  // Shared: serial
  const serial = output.match(/[Ss]erial\s+[Nn]umber[:\s]+(\S+)/);
  if (serial) result.serial = serial[1];

  return Object.keys(result).length > 0 ? result : null;
}

// ── Show VLAN ────────────────────────────────────────────────────────────────

export interface Vlan {
  id: string;
  name?: string;
  status?: string;
  interfaces?: string[];
}

export interface VlanTableResult {
  vlans: Vlan[];
}

/**
 * Parse `show vlan` output.
 *
 * NX-OS example:
 *   VLAN  Name                             Status    Ports
 *   ----  -------------------------------- --------- -----------------------------------
 *   1     default                          active    Eth1/1, Eth1/2
 *   10    mgmt                             active    Eth1/3
 *
 * Dell OS10 example:
 *   Q: U - Untagged, T - Tagged
 *     VLAN  Name                    Status
 *   ------  ----------------------  -------
 *        1  default                 Active
 *       10  Management              Active
 */
export function parseShowVlan(
  output: string,
  _platform: string
): VlanTableResult | null {
  const lines = output.split('\n');
  const vlans: Vlan[] = [];

  // Look for the VLAN table header
  const headerIdx = lines.findIndex((l) => /^\s*VLAN\s+Name/i.test(l));
  if (headerIdx < 0) return null;

  // Skip separator line(s)
  let startIdx = headerIdx + 1;
  while (startIdx < lines.length && /^[\s\-]+$/.test(lines[startIdx])) {
    startIdx++;
  }

  // Match: ID  Name  Status  [optional ports...]
  // Name may contain spaces (e.g. "Voice VLAN", "Management VLAN") so use a lookahead
  // to stop before the status keyword.
  const vlanLineRe = /^\s*(\d{1,4})\s+(.+?)\s{2,}(active|inactive|Active|Inactive)\s*(.*)?$/

  for (let i = startIdx; i < lines.length; i++) {
    const m = vlanLineRe.exec(lines[i]);
    if (m) {
      const portStr = m[4]?.trim() ?? '';
      vlans.push({
        id: m[1],
        name: m[2],
        status: m[3].toLowerCase(),
        interfaces: portStr
          ? portStr.split(/,\s*/).map((p) => p.trim()).filter(Boolean)
          : undefined,
      });
    } else if (/^\s*\d{1,4}\s+\S/.test(lines[i])) {
      // Dell OS10 may not have status column — capture full name (may include spaces)
      const simpleLine = lines[i].trim();
      const simpleMatch = /^(\d{1,4})\s+(.+?)\s*$/.exec(simpleLine);
      if (simpleMatch) {
        vlans.push({ id: simpleMatch[1], name: simpleMatch[2].trim() });
      }
    }
  }

  return vlans.length > 0 ? { vlans } : null;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

type ParsedOutput =
  | BgpSummaryResult
  | InterfaceStatusResult
  | LldpNeighborsResult
  | VersionResult
  | VlanTableResult;

/**
 * Dispatch to the appropriate parser based on the command string.
 *
 * Returns structured JSON if a matching parser exists and succeeds,
 * or null if the command is not recognized / parsing yields no data.
 */
export function parseOutput(
  command: string,
  output: string,
  platform: ParserPlatform | string
): ParsedOutput | null {
  const normalizedPlatform = normalizePlatform(platform);
  const cmd = command.trim().toLowerCase().replace(/\s+/g, ' ');

  if (cmd.includes('show ip bgp summary') || cmd.includes('show bgp summary')) {
    return parseShowIpBgpSummary(output, normalizedPlatform);
  }
  if (cmd.includes('show interface status') || cmd.includes('show interfaces status')) {
    return parseShowInterfaceStatus(output, normalizedPlatform);
  }
  if (cmd.includes('show lldp neighbor')) {
    return parseShowLldpNeighbors(output, normalizedPlatform);
  }
  if (cmd === 'show version' || cmd.startsWith('show version ')) {
    return parseShowVersion(output, normalizedPlatform);
  }
  if (cmd === 'show vlan' || cmd.startsWith('show vlan ')) {
    return parseShowVlan(output, normalizedPlatform);
  }

  return null;
}

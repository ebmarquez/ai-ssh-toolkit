/**
 * Unit tests for the structured output parsers.
 */
import { describe, it, expect } from 'vitest';
import {
  parseShowIpBgpSummary,
  parseShowInterfaceStatus,
  parseShowLldpNeighbors,
  parseShowVersion,
  parseShowVlan,
  parseOutput,
} from '../../src/parsers/index.js';

// ── BGP Summary ───────────────────────────────────────────────────────────────

describe('parseShowIpBgpSummary', () => {
  const NXOS_OUTPUT = `
BGP summary information for VRF default, address family IPv4 Unicast
BGP router identifier 10.0.0.1, local AS number 65000
BGP table version is 4, IPv4 Unicast config peers 2, capable peers 2

Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down  State/PfxRcd
10.0.0.2        4 65001     100     200        4    0    0 00:05:30        5
10.0.0.3        4 65002      50     100        4    0    0 00:01:15        3
`;

  it('parses NX-OS bgp summary', () => {
    const result = parseShowIpBgpSummary(NXOS_OUTPUT, 'nxos');
    expect(result).not.toBeNull();
    expect(result!.router_id).toBe('10.0.0.1');
    expect(result!.local_as).toBe('65000');
    expect(result!.peers).toHaveLength(2);
    expect(result!.peers[0].neighbor).toBe('10.0.0.2');
    expect(result!.peers[0].as).toBe('65001');
    expect(result!.peers[0].up_down).toBe('00:05:30');
    expect(result!.peers[0].state_pfx_rcvd).toBe('5');
    expect(result!.peers[1].neighbor).toBe('10.0.0.3');
  });

  it('returns null for empty output', () => {
    expect(parseShowIpBgpSummary('no bgp data here', 'nxos')).toBeNull();
  });
});

// ── Interface Status ──────────────────────────────────────────────────────────

describe('parseShowInterfaceStatus', () => {
  const NXOS_OUTPUT = `
--------------------------------------------------------------------------------
Port          Name               Status    Vlan      Duplex  Speed   Type
--------------------------------------------------------------------------------
Eth1/1        uplink             connected trunk     full    10G     10Gbase-SR
Eth1/2        --                 notconnect 1        auto    auto    10Gbase-T
`;

  it('parses NX-OS interface status', () => {
    const result = parseShowInterfaceStatus(NXOS_OUTPUT, 'nxos');
    expect(result).not.toBeNull();
    expect(result!.interfaces.length).toBeGreaterThanOrEqual(1);
    const eth1 = result!.interfaces.find((i) => i.interface === 'Eth1/1');
    expect(eth1).toBeDefined();
    expect(eth1!.status).toBe('connected');
    expect(eth1!.vlan).toBe('trunk');
    expect(eth1!.speed).toBe('10G');
  });

  it('returns null for unrecognized output', () => {
    expect(parseShowInterfaceStatus('nothing useful here', 'nxos')).toBeNull();
  });
});

// ── LLDP Neighbors ────────────────────────────────────────────────────────────

describe('parseShowLldpNeighbors', () => {
  const NXOS_OUTPUT = `
Capability codes:
  (R) Router, (B) Bridge, (T) Telephone

Device ID        Local Intf      Hold-time  Capability  Port ID
neighbor-sw1     Eth1/1          120        B, R        Eth0/1
neighbor-sw2     Eth1/2          120        B           Eth0/2
`;

  it('parses NX-OS lldp neighbors', () => {
    const result = parseShowLldpNeighbors(NXOS_OUTPUT, 'nxos');
    expect(result).not.toBeNull();
    expect(result!.neighbors.length).toBeGreaterThanOrEqual(1);
    const n1 = result!.neighbors[0];
    expect(n1.local_interface).toBe('Eth1/1');
    expect(n1.chassis_id).toBe('neighbor-sw1');
    expect(n1.port_id).toBe('Eth0/1');
    expect(n1.hold_time).toBe('120');
  });

  const OS10_OUTPUT = `
Local Interface   Chassis-id         Remote Port-id     System Name   Hold-time
ethernet1/1/1     00:11:22:33:44:55  ethernet1/1/2      neighbor-sw   120
ethernet1/1/2     aa:bb:cc:dd:ee:ff  ethernet1/1/3      core-sw       120
`;

  it('parses Dell OS10 lldp neighbors', () => {
    const result = parseShowLldpNeighbors(OS10_OUTPUT, 'dell-os10');
    expect(result).not.toBeNull();
    expect(result!.neighbors.length).toBeGreaterThanOrEqual(1);
    expect(result!.neighbors[0].local_interface).toBe('ethernet1/1/1');
    expect(result!.neighbors[0].chassis_id).toBe('00:11:22:33:44:55');
    expect(result!.neighbors[0].system_name).toBe('neighbor-sw');
  });

  it('returns null for empty output', () => {
    expect(parseShowLldpNeighbors('no lldp data', 'nxos')).toBeNull();
  });
});

// ── Show Version ─────────────────────────────────────────────────────────────

describe('parseShowVersion', () => {
  const NXOS_OUTPUT = `
Cisco Nexus Operating System (NX-OS) Software
  BIOS: version 08.35
  kickstart: version 7.0(3)I7(9)
  system:    version 7.0(3)I7(9)
Hardware
  cisco Nexus 9332C Chassis
  Processor Board ID FDO123456AB

Kernel uptime is 10 day(s), 3 hour(s), 22 minute(s), 5 second(s)
`;

  it('parses NX-OS show version', () => {
    const result = parseShowVersion(NXOS_OUTPUT, 'nxos');
    expect(result).not.toBeNull();
    expect(result!.os_version).toBe('7.0(3)I7(9)');
    expect(result!.firmware).toBe('7.0(3)I7(9)');
    expect(result!.model).toBe('Nexus 9332C');
    expect(result!.uptime).toContain('10 day(s)');
  });

  const DELL_OUTPUT = `
Dell EMC Networking OS10 Enterprise
Software Version: 10.5.3.4
System Type:      S5248F-ON
Uptime:           0 day(s), 2 hour(s), 10 minute(s)
`;

  it('parses Dell OS10 show version', () => {
    const result = parseShowVersion(DELL_OUTPUT, 'dell-os10');
    expect(result).not.toBeNull();
    expect(result!.os_version).toBe('10.5.3.4');
    expect(result!.model).toBe('S5248F-ON');
    expect(result!.uptime).toContain('0 day(s)');
  });

  it('returns null for empty output', () => {
    expect(parseShowVersion('', 'nxos')).toBeNull();
  });
});

// ── Show VLAN ─────────────────────────────────────────────────────────────────

describe('parseShowVlan', () => {
  const NXOS_OUTPUT = `
VLAN  Name                             Status    Ports
----  -------------------------------- --------- -----------------------------------
1     default                          active    Eth1/1, Eth1/2
10    mgmt                             active    Eth1/3
20    storage                          inactive
`;

  it('parses NX-OS show vlan', () => {
    const result = parseShowVlan(NXOS_OUTPUT, 'nxos');
    expect(result).not.toBeNull();
    expect(result!.vlans.length).toBeGreaterThanOrEqual(2);
    const vlan1 = result!.vlans.find((v) => v.id === '1');
    expect(vlan1).toBeDefined();
    expect(vlan1!.name).toBe('default');
    expect(vlan1!.status).toBe('active');
    expect(vlan1!.interfaces).toContain('Eth1/1');
    const vlan20 = result!.vlans.find((v) => v.id === '20');
    expect(vlan20).toBeDefined();
    expect(vlan20!.status).toBe('inactive');
  });

  it('returns null for unrecognized output', () => {
    expect(parseShowVlan('nothing here', 'nxos')).toBeNull();
  });
});

// ── Dispatcher ────────────────────────────────────────────────────────────────

describe('parseOutput dispatcher', () => {
  it('dispatches show ip bgp summary', () => {
    const output = `
BGP router identifier 10.0.0.1, local AS number 65000
Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down  State/PfxRcd
10.0.0.2        4 65001     100     200        4    0    0 00:05:30        5
`;
    const result = parseOutput('show ip bgp summary', output, 'nxos');
    expect(result).not.toBeNull();
    expect((result as { peers: unknown[] }).peers).toBeDefined();
  });

  it('dispatches show version', () => {
    const output = `
  system:    version 7.0(3)I7(9)
  cisco Nexus 9332C Chassis
Kernel uptime is 1 day(s), 0 hour(s), 0 minute(s), 0 second(s)
`;
    const result = parseOutput('show version', output, 'nxos');
    expect(result).not.toBeNull();
  });

  it('returns null for unknown commands', () => {
    expect(parseOutput('show running-config', 'some output', 'auto')).toBeNull();
  });

  it('is case and spacing tolerant', () => {
    const output = `
BGP router identifier 10.0.0.1, local AS number 65000
Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down  State/PfxRcd
10.0.0.2        4 65001     100     200        4    0    0 00:05:30        5
`;
    const result = parseOutput('  Show IP BGP Summary  ', output, 'auto');
    expect(result).not.toBeNull();
  });
});

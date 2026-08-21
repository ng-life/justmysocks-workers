import { describe, expect, it } from "vitest";
import {
  abbreviateClashNodeNames,
  buildClashUrl,
  buildTrafficUrl,
  cachedUpstream,
  convertClashToLoon,
  convertClashToQuanx,
  normalizeTraffic,
} from "../src/index";
import type { CacheConfig, CacheStore } from "../src/index";

class MemoryCache implements CacheStore {
  readonly values = new Map<string, string>();

  async match(request: Request): Promise<Response | undefined> {
    const value = this.values.get(request.url);
    return value === undefined ? undefined : new Response(value);
  }

  async put(request: Request, response: Response): Promise<void> {
    this.values.set(request.url, await response.text());
  }
}

const cacheConfig: CacheConfig = {
  freshTtlSeconds: 600,
  staleTtlSeconds: 3600,
  failureCooldownSeconds: 30,
};

describe("URL construction", () => {
  it("copies identity and subscription tweak parameters", () => {
    const request = new URL(
      "https://worker.example/quanx?service=1437420&id=test-id&noss=1&exclude=3,5&usedomains=1",
    );
    expect(buildClashUrl(request).toString()).toBe(
      "https://jmssub.net/members/getsub.php?service=1437420&id=test-id&format=clash&noss=1&exclude=3%2C5&usedomains=1",
    );
    expect(buildTrafficUrl(request).toString()).toBe(
      "https://justmysocks6.net/members/getbwcounter.php?service=1437420&id=test-id",
    );
  });
});

describe("Clash node names", () => {
  it("abbreviates JMS nodes and updates proxy group references", () => {
    const yaml = `
# keep this comment
proxies:
  - {name: "JMS-1@c2s1.example.com:5086", type: ss, server: 192.0.2.1, port: 5086}
  - {name: "Custom Node", type: ss, server: 192.0.2.2, port: 5087}
proxy-groups:
  - name: Auto
    type: select
    proxies: ["JMS-1@c2s1.example.com:5086", "Custom Node"]
`;

    const result = abbreviateClashNodeNames(yaml);

    expect(result).toContain("# keep this comment");
    expect(result).toContain('name: "c2s1"');
    expect(result).toContain('name: "Custom Node"');
    expect(result).toContain('proxies: [ "c2s1", "Custom Node" ]');
    expect(result).not.toContain("JMS-1@c2s1.example.com:5086");
  });
});

describe("Clash to Quantumult X", () => {
  it("uses normalized node names while converting SS and VLESS", () => {
    const yaml = `
proxies:
  - name: c2s1
    type: ss
    server: 192.0.2.1
    port: 5086
    cipher: aes-256-gcm
    password: secret
    udp: true
  - name: c2s3
    type: vless
    server: 192.0.2.3
    port: 443
    uuid: test-uuid
    tls: true
    servername: portal.example.com
    flow: xtls-rprx-vision
    reality-opts:
      public-key: public-key
      short-id: 051f20c2344a2dfd
`;
    const result = convertClashToQuanx(yaml);
    expect(result).toContain(
      "shadowsocks=192.0.2.1:5086, method=aes-256-gcm, password=secret, udp-relay=true, tag=c2s1",
    );
    expect(result).toContain(
      "vless=192.0.2.3:443, method=none, password=test-uuid, obfs=over-tls, obfs-host=portal.example.com, reality-base64-pubkey=public-key, reality-hex-shortid=051f20c2344a2dfd, vless-flow=xtls-rprx-vision, tag= c2s3",
    );
  });
});

describe("Clash to Loon", () => {
  it("converts supported nodes with Loon parameter names and quoting", () => {
    const yaml = `
proxies:
  - {name: c2s1, type: ss, server: 192.0.2.1, port: 1001, cipher: aes-256-gcm, password: "sec,ret", udp: true}
  - name: VMess WS
    type: vmess
    server: vmess.example.com
    port: 443
    uuid: vmess-uuid
    cipher: auto
    alterId: 0
    tls: true
    servername: cdn.example.com
    network: ws
    ws-opts: {path: /ws, headers: {Host: cdn.example.com}}
  - name: VLESS Reality
    type: vless
    server: vless.example.com
    port: 443
    uuid: vless-uuid
    tls: true
    servername: portal.example.com
    flow: xtls-rprx-vision
    reality-opts: {public-key: public-key, short-id: 051f20c2344a2dfd}
  - {name: Trojan, type: trojan, server: trojan.example.com, port: 443, password: pass, sni: trojan.example.com}
  - {name: HTTPS, type: http, server: http.example.com, port: 443, username: "user,name", password: pass, tls: true, sni: http.example.com}
  - {name: SOCKS, type: socks5, server: socks.example.com, port: 1080, username: user, password: pass, udp: true}
`;
    const result = convertClashToLoon(yaml);
    expect(result).toContain(
      'c2s1 = Shadowsocks,192.0.2.1,1001,aes-256-gcm,"sec,ret",fast-open=false,udp=true',
    );
    expect(result).toContain(
      'VMess WS = vmess,vmess.example.com,443,auto,"vmess-uuid",transport=ws,alterId=0,over-tls=true,path="/ws",host="cdn.example.com",sni=cdn.example.com,skip-cert-verify=false,udp=true',
    );
    expect(result).toContain(
      'VLESS Reality = VLESS,vless.example.com,443,"vless-uuid",transport=tcp,over-tls=true,flow=xtls-rprx-vision,public-key="public-key",short-id=051f20c2344a2dfd,sni=portal.example.com,skip-cert-verify=false,udp=true',
    );
    expect(result).toContain(
      'Trojan = trojan,trojan.example.com,443,"pass",transport=tcp,sni=trojan.example.com,skip-cert-verify=false,udp=true',
    );
    expect(result).toContain(
      'HTTPS = https,http.example.com,443,"user,name","pass",sni=http.example.com,skip-cert-verify=false',
    );
    expect(result).toContain(
      'SOCKS = socks5,socks.example.com,1080,"user","pass",skip-cert-verify=false,udp=true',
    );
  });
});

describe("traffic normalization", () => {
  it("generates subscription information and the next LA reset", () => {
    const info = normalizeTraffic(
      { monthly_bw_limit_b: 500_000, bw_counter_b: 1_234, bw_reset_day_of_month: 16 },
      new Date("2026-08-17T00:00:00Z"),
    );
    expect(info.remaining).toBe(498_766);
    expect(info.expires_at).toBe("2026-09-16T07:00:00.000Z");
    expect(info.expire).toBe(1_789_542_000);
  });
});

describe("upstream cache", () => {
  it("hits fresh data and uses stale data during failure cooldown", async () => {
    const cache = new MemoryCache();
    const url = new URL("https://upstream.example/sub?service=1&id=secret-id");
    const fetchedAt = 1_800_000_000_000;
    let currentTime = fetchedAt;
    let fetches = 0;
    let fails = false;
    const fetcher = async () => {
      fetches += 1;
      if (fails) throw new Error("rate limited");
      return "proxies: []\n";
    };
    const validate = (value: unknown): value is string => typeof value === "string";

    const miss = await cachedUpstream(
      cache,
      "clash",
      url,
      "https://worker.example",
      cacheConfig,
      validate,
      fetcher,
      () => currentTime,
    );
    expect(miss.status).toBe("MISS");
    const hit = await cachedUpstream(
      cache,
      "clash",
      url,
      "https://worker.example",
      cacheConfig,
      validate,
      fetcher,
      () => currentTime,
    );
    expect(hit.status).toBe("HIT");
    expect(fetches).toBe(1);
    expect([...cache.values.keys()][0]).not.toContain("secret-id");

    currentTime += 601_000;
    fails = true;
    const stale = await cachedUpstream(
      cache,
      "clash",
      url,
      "https://worker.example",
      cacheConfig,
      validate,
      fetcher,
      () => currentTime,
    );
    expect(stale.status).toBe("STALE");
    currentTime += 10_000;
    const cooldown = await cachedUpstream(
      cache,
      "clash",
      url,
      "https://worker.example",
      cacheConfig,
      validate,
      fetcher,
      () => currentTime,
    );
    expect(cooldown.status).toBe("STALE");
    expect(fetches).toBe(2);

    currentTime = fetchedAt + 3_601_000;
    await expect(
      cachedUpstream(
        cache,
        "clash",
        url,
        "https://worker.example",
        cacheConfig,
        validate,
        fetcher,
        () => currentTime,
      ),
    ).rejects.toThrow("rate limited");
    expect(fetches).toBe(3);
  });

});

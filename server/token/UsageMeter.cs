// Spectra — medidor do tráfego de saída do mês.
//
// O nível Always Free da Oracle tem uma cota mensal de tráfego de saída. Para
// nunca passar dela, este serviço soma, a cada minuto, os bytes enviados pelas
// placas de rede da VM (o serviço roda com network_mode: host, então enxerga as
// placas da própria VM em /proc/net/dev). Ao atingir o limite configurado
// (SPECTRA_MONTHLY_LIMIT_GB, padrão 5000 GB = 5 TB), o servidor:
//   - recusa novas entradas (o app mostra o aviso);
//   - encerra as salas abertas no LiveKit;
//   - informa o bloqueio em /api/usage (o app e a página de download leem dali).
// O contador zera no dia 1º de cada mês (UTC) e fica salvo em disco.
//
// A medida inclui todo o tráfego de saída da VM (mídia, TURN, HTTPS, atualizações),
// então tende a ficar um pouco acima do que a Oracle cobra: erra para o lado seguro.

using System.Globalization;
using System.Text.Json;

sealed class UsageMeter : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);
    private const double WarnFraction = 0.8;

    private readonly ILogger<UsageMeter> _log;
    private readonly LiveKitAdmin _livekit;
    private readonly string _statePath;
    private readonly string? _iface;
    private readonly object _lock = new();
    private UsageState _state;

    public long LimitBytes { get; }

    public UsageMeter(ILogger<UsageMeter> log, LiveKitAdmin livekit)
    {
        _log = log;
        _livekit = livekit;
        var limitGb = double.TryParse(Environment.GetEnvironmentVariable("SPECTRA_MONTHLY_LIMIT_GB"),
            NumberStyles.Float, CultureInfo.InvariantCulture, out var gb) && gb > 0 ? gb : 5000;
        LimitBytes = (long)(limitGb * 1_000_000_000);
        _statePath = Environment.GetEnvironmentVariable("SPECTRA_USAGE_FILE") is { Length: > 0 } p ? p : "/data/usage.json";
        _iface = Environment.GetEnvironmentVariable("SPECTRA_NET_IFACE") is { Length: > 0 } i ? i : null;
        _state = Load() ?? new UsageState(CurrentMonth(DateTimeOffset.UtcNow), 0, -1, "");
    }

    /// <summary>Situação atual, para a API.</summary>
    public UsageResponse Snapshot()
    {
        lock (_lock)
        {
            var now = DateTimeOffset.UtcNow;
            var used = _state.Month == CurrentMonth(now) ? _state.Bytes : 0;
            var resets = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero).AddMonths(1);
            var percent = LimitBytes > 0 ? Math.Round(used * 100.0 / LimitBytes, 1) : 0;
            var status = used >= LimitBytes ? "blocked" : used >= LimitBytes * WarnFraction ? "warning" : "ok";
            return new UsageResponse(status, _state.Month, used, LimitBytes, percent, resets.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        }
    }

    public bool IsBlocked => Snapshot().Status == "blocked";

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        _log.LogInformation("Medidor de tráfego: limite de {Limit:N0} GB por mês, estado em {Path}.", LimitBytes / 1e9, _statePath);
        while (!stop.IsCancellationRequested)
        {
            try
            {
                Sample();
                if (IsBlocked) await _livekit.CloseAllRoomsAsync(stop);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log.LogWarning(ex, "Falha ao medir o tráfego.");
            }
            await Task.Delay(Interval, stop).ContinueWith(_ => { }, CancellationToken.None);
        }
    }

    /// <summary>Lê o contador da placa de rede e soma o que saiu desde a última leitura.</summary>
    internal void Sample()
    {
        var tx = NetworkCounters.ReadTxBytes(_iface);
        if (tx is null) return;
        var bootId = NetworkCounters.BootId();
        var month = CurrentMonth(DateTimeOffset.UtcNow);

        lock (_lock)
        {
            var s = _state;
            long delta;
            if (s.LastTx < 0) delta = 0;                          // primeira leitura: só guarda a referência
            else if (s.BootId != bootId || tx < s.LastTx) delta = tx.Value; // a VM reiniciou: o contador recomeçou do zero
            else delta = tx.Value - s.LastTx;

            var bytes = s.Month == month ? s.Bytes + delta : delta;
            var wasBlocked = s.Month == month && s.Bytes >= LimitBytes;
            _state = new UsageState(month, bytes, tx.Value, bootId);
            Save(_state);

            if (!wasBlocked && bytes >= LimitBytes)
                _log.LogWarning("Limite mensal de tráfego atingido ({Used:N1} GB). Spectra bloqueado até o próximo mês.", bytes / 1e9);
        }
    }

    private static string CurrentMonth(DateTimeOffset t) => t.ToString("yyyy-MM", CultureInfo.InvariantCulture);

    private UsageState? Load()
    {
        try
        {
            return File.Exists(_statePath)
                ? JsonSerializer.Deserialize(File.ReadAllText(_statePath), ApiJson.Default.UsageState)
                : null;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Não consegui ler {Path}; começando do zero.", _statePath);
            return null;
        }
    }

    private void Save(UsageState s)
    {
        var dir = Path.GetDirectoryName(_statePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var tmp = _statePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(s, ApiJson.Default.UsageState));
        File.Move(tmp, _statePath, overwrite: true);
    }
}

static class NetworkCounters
{
    // Placas virtuais (Docker, pontes) só repetem o tráfego que já passa pela placa real.
    private static readonly string[] VirtualPrefixes = ["lo", "docker", "veth", "br-", "virbr", "cni", "flannel", "tun", "tap"];

    /// <summary>Total de bytes enviados desde o boot, somando as placas reais (ou só a indicada).</summary>
    public static long? ReadTxBytes(string? onlyIface, string path = "/proc/net/dev")
    {
        if (!File.Exists(path)) return null;
        long total = 0;
        var found = false;
        foreach (var line in File.ReadLines(path).Skip(2))
        {
            var colon = line.IndexOf(':');
            if (colon < 0) continue;
            var name = line[..colon].Trim();
            if (onlyIface is not null ? name != onlyIface : VirtualPrefixes.Any(p => name.StartsWith(p, StringComparison.Ordinal))) continue;
            var fields = line[(colon + 1)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            // recebidos: bytes packets errs drop fifo frame compressed multicast | enviados: bytes ...
            if (fields.Length > 8 && long.TryParse(fields[8], out var tx))
            {
                total += tx;
                found = true;
            }
        }
        return found ? total : null;
    }

    public static string BootId(string path = "/proc/sys/kernel/random/boot_id")
    {
        try
        {
            return File.ReadAllText(path).Trim();
        }
        catch
        {
            return "";
        }
    }
}

/// <summary>Chamadas administrativas ao LiveKit (API Twirp local), para encerrar as salas.</summary>
sealed class LiveKitAdmin(TokenConfig config, IHttpClientFactory http, ILogger<LiveKitAdmin> log)
{
    private readonly string _baseUrl = Environment.GetEnvironmentVariable("LIVEKIT_API_URL") is { Length: > 0 } u
        ? u.TrimEnd('/')
        : "http://127.0.0.1:7880";

    public async Task CloseAllRoomsAsync(CancellationToken ct)
    {
        var list = await CallAsync("ListRooms", "{}", ct);
        if (list is null) return;
        using var doc = JsonDocument.Parse(list);
        if (!doc.RootElement.TryGetProperty("rooms", out var rooms)) return;
        foreach (var room in rooms.EnumerateArray())
        {
            var name = room.GetProperty("name").GetString();
            if (string.IsNullOrEmpty(name)) continue;
            await CallAsync("DeleteRoom", JsonSerializer.Serialize(new DeleteRoomRequest(name), ApiJson.Default.DeleteRoomRequest), ct);
            log.LogWarning("Sala {Room} encerrada: limite mensal de tráfego atingido.", name);
        }
    }

    private async Task<string?> CallAsync(string method, string body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/twirp/livekit.RoomService/{method}")
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new("Bearer", LiveKitToken.CreateAdmin(config.ApiKey, config.ApiSecret, TimeSpan.FromMinutes(5)));
        using var res = await http.CreateClient().SendAsync(req, ct);
        if (res.IsSuccessStatusCode) return await res.Content.ReadAsStringAsync(ct);
        log.LogWarning("LiveKit {Method} respondeu {Status}.", method, (int)res.StatusCode);
        return null;
    }
}

record UsageState(string Month, long Bytes, long LastTx, string BootId);
record UsageResponse(string Status, string Month, long UsedBytes, long LimitBytes, double Percent, string ResetsOn);
record DeleteRoomRequest(string Room);

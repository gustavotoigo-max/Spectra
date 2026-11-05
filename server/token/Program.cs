// Spectra — serviço de tokens.
// Gera os tokens de acesso (JWT) que o app usa para entrar nas salas do LiveKit.
// A chave secreta do LiveKit fica só aqui no servidor; o app conhece apenas a
// "chave de acesso" do grupo (SPECTRA_ACCESS_KEY), que você passa para os amigos.

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateSlimBuilder(args);

var config = TokenConfig.FromEnvironment();

builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Insert(0, ApiJson.Default));
builder.Services.AddSingleton(config);
builder.Services.AddHttpClient();
builder.Services.AddSingleton<LiveKitAdmin>();
builder.Services.AddSingleton<UsageMeter>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<UsageMeter>());
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().WithMethods("GET", "POST")));
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    // Por IP: 20 pedidos de token por minuto é muito mais do que um grupo de amigos precisa,
    // e trava quem tentar adivinhar a chave de acesso.
    o.AddPolicy("token", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ClientIp(ctx),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 20, Window = TimeSpan.FromMinutes(1) }));
});

var app = builder.Build();
app.UseCors();
app.UseRateLimiter();

app.MapGet("/health", () => Results.Ok(new HealthResponse("ok", config.PublicUrl)));

// Uso do tráfego mensal: público, para o app e a página de download mostrarem o aviso.
app.MapGet("/usage", (UsageMeter meter) => Results.Ok(meter.Snapshot()));

app.MapPost("/token", (TokenRequest? req, UsageMeter meter) =>
{
    if (req is null) return Results.BadRequest(new ErrorResponse("Pedido inválido."));

    var usage = meter.Snapshot();
    if (usage.Status == "blocked")
        return Results.Json(
            new ErrorResponse($"O servidor atingiu o limite de tráfego do mês ({usage.LimitBytes / 1_000_000_000_000.0:0.#} TB). O Spectra volta a funcionar em {Validation.DateBr(usage.ResetsOn)}."),
            ApiJson.Default.ErrorResponse, statusCode: 403);

    if (!config.CheckAccessKey(req.AccessKey))
        return Results.Json(new ErrorResponse("Chave de acesso incorreta."), ApiJson.Default.ErrorResponse, statusCode: 401);

    var room = (req.Room ?? "").Trim().ToUpperInvariant();
    if (!Validation.RoomCode().IsMatch(room))
        return Results.BadRequest(new ErrorResponse("Código de sala inválido (use de 4 a 12 letras ou números)."));

    var name = Validation.CleanName(req.Name);
    if (name is null)
        return Results.BadRequest(new ErrorResponse("Informe um nome de 1 a 32 caracteres."));

    var identity = $"{Validation.Slug(name)}-{RandomNumberGenerator.GetHexString(6, lowercase: true)}";
    var token = LiveKitToken.Create(config.ApiKey, config.ApiSecret, identity, name, room, TimeSpan.FromHours(12));

    return Results.Ok(new TokenResponse(token, config.PublicUrl, identity, room));
}).RequireRateLimiting("token");

app.Run();

static string ClientIp(HttpContext ctx) =>
    ctx.Request.Headers["X-Forwarded-For"].FirstOrDefault()?.Split(',')[0].Trim()
    ?? ctx.Connection.RemoteIpAddress?.ToString()
    ?? "unknown";

// ---------------------------------------------------------------------------

sealed record TokenConfig(string ApiKey, string ApiSecret, string AccessKey, string PublicUrl)
{
    public static TokenConfig FromEnvironment()
    {
        static string Need(string name) =>
            Environment.GetEnvironmentVariable(name) is { Length: > 0 } v
                ? v
                : throw new InvalidOperationException($"Variável de ambiente {name} não definida.");

        return new TokenConfig(
            Need("LIVEKIT_API_KEY"),
            Need("LIVEKIT_API_SECRET"),
            Need("SPECTRA_ACCESS_KEY"),
            Need("LIVEKIT_PUBLIC_URL"));
    }

    public bool CheckAccessKey(string? given)
    {
        var a = Encoding.UTF8.GetBytes(given ?? "");
        var b = Encoding.UTF8.GetBytes(AccessKey);
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(a), SHA256.HashData(b));
    }
}

static partial class Validation
{
    [GeneratedRegex("^[A-Z0-9]{4,12}$")]
    public static partial Regex RoomCode();

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex NonSlug();

    public static string? CleanName(string? raw)
    {
        var name = new string((raw ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        return name.Length is >= 1 and <= 32 ? name : null;
    }

    public static string DateBr(string isoDate) =>
        DateOnly.TryParseExact(isoDate, "yyyy-MM-dd", out var d) ? d.ToString("dd/MM/yyyy", System.Globalization.CultureInfo.InvariantCulture) : isoDate;

    public static string Slug(string name)
    {
        var plain = new string(name.Normalize(NormalizationForm.FormD)
            .Where(c => System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.NonSpacingMark)
            .ToArray());
        var s = NonSlug().Replace(plain.ToLowerInvariant(), "-").Trim('-');
        if (s.Length == 0) s = "user";
        return s.Length > 16 ? s[..16] : s;
    }
}

/// <summary>Token de acesso do LiveKit: um JWT HS256 com as permissões da sala.</summary>
static class LiveKitToken
{
    public static string Create(string apiKey, string apiSecret, string identity, string name, string room, TimeSpan ttl)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var claims = new LiveKitClaims(
            Iss: apiKey,
            Sub: identity,
            Name: name,
            Nbf: now - 10,
            Exp: now + (long)ttl.TotalSeconds,
            Video: new VideoGrant(
                Room: room,
                RoomJoin: true,
                CanPublish: true,          // qualquer um pode transmitir, como no Discord
                CanSubscribe: true,
                CanPublishData: true,
                CanUpdateOwnMetadata: true // o transmissor anuncia as camadas de qualidade
            ));

        return Sign(apiSecret, JsonSerializer.SerializeToUtf8Bytes(claims, ApiJson.Default.LiveKitClaims));
    }

    /// <summary>Token só para o próprio servidor: listar e encerrar salas.</summary>
    public static string CreateAdmin(string apiKey, string apiSecret, TimeSpan ttl)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var claims = new AdminClaims(apiKey, now - 10, now + (long)ttl.TotalSeconds, new AdminGrant(RoomList: true, RoomCreate: true));
        return Sign(apiSecret, JsonSerializer.SerializeToUtf8Bytes(claims, ApiJson.Default.AdminClaims));
    }

    private static string Sign(string apiSecret, byte[] claimsJson)
    {
        var header = B64(JsonSerializer.SerializeToUtf8Bytes(new JwtHeader("HS256", "JWT"), ApiJson.Default.JwtHeader));
        var signingInput = $"{header}.{B64(claimsJson)}";
        var signature = HMACSHA256.HashData(Encoding.UTF8.GetBytes(apiSecret), Encoding.UTF8.GetBytes(signingInput));
        return $"{signingInput}.{B64(signature)}";
    }

    private static string B64(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

record TokenRequest(string? Room, string? Name, string? AccessKey);
record TokenResponse(string Token, string Url, string Identity, string Room);
record ErrorResponse(string Error);
record HealthResponse(string Status, string Url);
record JwtHeader(string Alg, string Typ);
record VideoGrant(string Room, bool RoomJoin, bool CanPublish, bool CanSubscribe, bool CanPublishData, bool CanUpdateOwnMetadata);
record LiveKitClaims(string Iss, string Sub, string Name, long Nbf, long Exp, VideoGrant Video);
record AdminGrant(bool RoomList, bool RoomCreate);
record AdminClaims(string Iss, long Nbf, long Exp, AdminGrant Video);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(TokenRequest))]
[JsonSerializable(typeof(TokenResponse))]
[JsonSerializable(typeof(ErrorResponse))]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(JwtHeader))]
[JsonSerializable(typeof(LiveKitClaims))]
[JsonSerializable(typeof(AdminClaims))]
[JsonSerializable(typeof(UsageState))]
[JsonSerializable(typeof(UsageResponse))]
[JsonSerializable(typeof(DeleteRoomRequest))]
partial class ApiJson : JsonSerializerContext;

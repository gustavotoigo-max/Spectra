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

app.MapPost("/token", (TokenRequest? req) =>
{
    if (req is null) return Results.BadRequest(new ErrorResponse("Pedido inválido."));

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

        var header = B64(JsonSerializer.SerializeToUtf8Bytes(new JwtHeader("HS256", "JWT"), ApiJson.Default.JwtHeader));
        var payload = B64(JsonSerializer.SerializeToUtf8Bytes(claims, ApiJson.Default.LiveKitClaims));
        var signingInput = $"{header}.{payload}";
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

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(TokenRequest))]
[JsonSerializable(typeof(TokenResponse))]
[JsonSerializable(typeof(ErrorResponse))]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(JwtHeader))]
[JsonSerializable(typeof(LiveKitClaims))]
partial class ApiJson : JsonSerializerContext;

using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace Spectra;

/// <summary>
/// Janela do Spectra: um WebView2 (o Edge/Chromium que já vem no Windows 10 e 11)
/// rodando a interface embutida. A captura de tela, a codificação e o WebRTC
/// ficam por conta do motor do navegador; o C# cuida da janela, das permissões,
/// da tela cheia e de servir os arquivos da interface.
/// </summary>
public partial class MainWindow : Window
{
    private const string AppHost = "app.spectra";
    private static readonly string AppOrigin = $"https://{AppHost}";

    private static readonly string Version =
        Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0]
        ?? "0.0.0";

    private readonly Assembly _assembly = Assembly.GetExecutingAssembly();

    // estado salvo ao entrar em tela cheia
    private WindowState _restoreState;
    private WindowStyle _restoreStyle;
    private ResizeMode _restoreResize;
    private bool _isFullScreen;

    public MainWindow()
    {
        InitializeComponent();
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0x0A, 0x0B, 0x11);
        SourceInitialized += (_, _) => UseDarkTitleBar();
        Loaded += async (_, _) => await InitializeWebViewAsync();
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Spectra", "WebView2");

            var options = new CoreWebView2EnvironmentOptions(string.Join(' ',
                "--autoplay-policy=no-user-gesture-required",
                // continua capturando e codificando com a janela minimizada ou atrás do jogo
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows"));

            var env = await CoreWebView2Environment.CreateAsync(null, dataDir, options);
            await Web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            var open = MessageBox.Show(
                "O Spectra precisa do Microsoft Edge WebView2, que não foi encontrado neste computador.\n\nAbrir a página de download?",
                "Spectra", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (open == MessageBoxResult.Yes)
                OpenExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            Close();
            return;
        }

        var core = Web.CoreWebView2;

#if DEBUG
        core.Settings.AreDevToolsEnabled = true;
#else
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // sem Ctrl+R, Ctrl+P etc.
#endif
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;

        // A interface vem dos recursos embutidos no .exe.
        core.AddWebResourceRequestedFilter($"{AppOrigin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += ServeEmbeddedFile;

        // Permissões (captura de tela, áudio, área de transferência) só para a nossa interface.
        core.PermissionRequested += (_, e) =>
        {
            e.State = IsAppUri(e.Uri) ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
        };

        // Links externos abrem no navegador padrão.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        core.NavigationStarting += (_, e) =>
        {
            if (IsAppUri(e.Uri)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        };

        core.ContainsFullScreenElementChanged += (_, _) => SetFullScreen(core.ContainsFullScreenElement);

        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            $"window.spectraHost = Object.freeze({{ version: '{Version}', platform: 'windows' }});");

        core.Navigate($"{AppOrigin}/index.html");
    }

    // ---- arquivos da interface ------------------------------------------------

    private void ServeEmbeddedFile(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var path = new Uri(e.Request.Uri).AbsolutePath.TrimStart('/');
        if (path.Length == 0) path = "index.html";

        var stream = _assembly.GetManifestResourceStream($"wwwroot/{path}")
                     ?? _assembly.GetManifestResourceStream($"wwwroot/{path.Replace('/', '\\')}");

        var env = Web.CoreWebView2.Environment;
        if (stream is null)
        {
            e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain");
            return;
        }

        var headers = $"Content-Type: {ContentType(path)}\r\nCache-Control: no-cache";
        e.Response = env.CreateWebResourceResponse(stream, 200, "OK", headers);
    }

    private static string ContentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" or ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" or ".map" => "application/json",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream",
    };

    private static bool IsAppUri(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u) && u.Scheme == "https" && u.Host == AppHost;

    private static void OpenExternal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var u) || (u.Scheme != "https" && u.Scheme != "http")) return;
        try
        {
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        }
        catch
        {
            /* sem navegador padrão configurado */
        }
    }

    // ---- tela cheia --------------------------------------------------------------

    private void SetFullScreen(bool on)
    {
        if (on == _isFullScreen) return;
        _isFullScreen = on;

        if (on)
        {
            _restoreState = WindowState;
            _restoreStyle = WindowStyle;
            _restoreResize = ResizeMode;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            // Normal → Maximized faz a janela cobrir também a barra de tarefas.
            WindowState = WindowState.Normal;
            WindowState = WindowState.Maximized;
        }
        else
        {
            WindowStyle = _restoreStyle;
            ResizeMode = _restoreResize;
            WindowState = _restoreState;
        }
    }

    // ---- barra de título escura (Windows 10 20H1+ e 11) ---------------------------

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    private void UseDarkTitleBar()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        var on = 1;
        DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int)); // DWMWA_USE_IMMERSIVE_DARK_MODE
        var caption = 0x00110B0A; // #0A0B11 em COLORREF (0x00BBGGRR)
        DwmSetWindowAttribute(hwnd, 35, ref caption, sizeof(int)); // DWMWA_CAPTION_COLOR (Windows 11)
        var border = 0x00452E2C; // #2C2E45
        DwmSetWindowAttribute(hwnd, 34, ref border, sizeof(int)); // DWMWA_BORDER_COLOR (Windows 11)
    }
}

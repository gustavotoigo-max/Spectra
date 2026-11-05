# Imagem multi-arquitetura (funciona na VM ARM gratuita da Oracle e em x64).
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY Spectra.Token.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://127.0.0.1:5080
# contador de tráfego do mês (volume spectra_data)
RUN mkdir -p /data && chown app /data
USER app
ENTRYPOINT ["dotnet", "Spectra.Token.dll"]

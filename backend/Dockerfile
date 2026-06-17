# Multi-stage build for the ChatbotApi (.NET 10) backend.
# Targets linux/amd64 by default; use buildx for arm64 if needed.

ARG DOTNET_VERSION=10.0
ARG ASPNET_VERSION=10.0

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS build
WORKDIR /src

# Restore as a distinct layer for better caching. Build context = ./backend.
COPY ChatbotApi/ChatbotApi.csproj ChatbotApi/
RUN dotnet restore ChatbotApi/ChatbotApi.csproj

# Copy the rest and publish.
COPY . .
RUN dotnet publish ChatbotApi/ChatbotApi.csproj \
        -c Release \
        -o /app/publish \
        --no-restore \
        /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:${ASPNET_VERSION} AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080 \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_RUNNING_IN_CONTAINER=true
EXPOSE 8080
COPY --from=build /app/publish/ ./
USER $APP_UID
ENTRYPOINT ["dotnet", "ChatbotApi.dll"]

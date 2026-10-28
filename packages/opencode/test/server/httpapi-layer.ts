import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import type { Interface as RuntimeLifecycle } from "../../src/server/runtime-lifecycle"

function servedRoutes(routes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer>) {
  return HttpRouter.serve(routes, {
    disableListenLog: true,
    disableLogger: true,
  })
}

function layer(routes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer>) {
  return servedRoutes(routes).pipe(
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  )
}

export const httpApiLayer = layer(HttpApiApp.routes)

export function httpApiLayerWithRuntime(runtime: RuntimeLifecycle) {
  return layer(HttpApiApp.createRoutes(undefined, runtime))
}

export function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

export function requestInDirectory(path: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return request(path, { ...init, headers })
}

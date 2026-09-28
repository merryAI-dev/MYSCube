variable "cloudflare_zone_id" {
  description = "Cloudflare zone id for the production domain."
  type        = string
}

variable "config_status" {
  description = "Current maturity status. Must remain draft until all production gates pass."
  type        = string
  default     = "draft"

  validation {
    condition     = contains(["draft", "candidate", "approved"], var.config_status)
    error_message = "config_status must be one of draft, candidate, approved."
  }
}

variable "vercel_apps" {
  description = "Vercel-backed apps that must be exposed only through Cloudflare-proxied custom domains."
  type = list(object({
    app_name       = string
    hostname       = string
    vercel_origin  = string
    origin_project = optional(string, "")
    enabled        = optional(bool, true)
    ttl            = optional(number, 1)
  }))
}

variable "extra_web_records" {
  description = "Non-Vercel web DNS records that must also be proxied by Cloudflare."
  type = list(object({
    name    = string
    type    = string
    content = string
    ttl     = optional(number, 1)
  }))
  default = []
}

variable "web_records_proxied" {
  description = "Whether web DNS records are proxied through Cloudflare. Use false temporarily when Vercel must issue certificates before proxy cutover."
  type        = bool
  default     = true
}

variable "enable_managed_waf" {
  description = "Whether to execute Cloudflare managed WAF rulesets. Requires plan entitlement."
  type        = bool
  default     = false
}

variable "enable_rate_limits" {
  description = "Whether to manage http_ratelimit ruleset in Terraform. Disable when the zone already has a phase entrypoint ruleset outside Terraform."
  type        = bool
  default     = false
}

variable "admin_path_expression" {
  description = "Cloudflare expression matching browser-only admin routes. Do not include API or Firebase auth helper paths."
  type        = string
  default     = "(starts_with(http.request.uri.path, \"/admin\") or starts_with(http.request.uri.path, \"/settings\") or starts_with(http.request.uri.path, \"/users\"))"
}

variable "login_path_expression" {
  description = "Cloudflare expression matching app login screens. Firebase /__/auth helper paths are intentionally excluded."
  type        = string
  default     = "(starts_with(http.request.uri.path, \"/login\") or starts_with(http.request.uri.path, \"/workspace-select\"))"
}

variable "api_path_expression" {
  description = "Cloudflare expression matching API-like endpoints. Must be smoke-tested before enforcement."
  type        = string
  default     = "(starts_with(http.request.uri.path, \"/api\") or http.request.uri.path contains \"/cashflow-sheet-lab\")"
}

variable "axr_workbench_egress_ips" {
  description = "Public egress IPs of the AXR workbench host. The MYSCube-AXR-Workbench User-Agent is blocked everywhere else; an empty list blocks it entirely."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for ip in var.axr_workbench_egress_ips : can(regex("^\\d{1,3}(\\.\\d{1,3}){3}$", ip)) && can(cidrhost("${ip}/32", 0))])
    error_message = "axr_workbench_egress_ips must contain single IPv4 addresses."
  }
}

variable "legacy_redirects" {
  description = "Legacy public hostnames that must redirect to the canonical Cloudflare hostname."
  type = list(object({
    hostname = string
    target   = string
    enabled  = optional(bool, true)
  }))
  default = []
}

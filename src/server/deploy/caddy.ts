/** Caddy site blocks written to /etc/caddy/sites/<slug>.caddy on the site servers. */

export type CaddySiteInput = {
  slug: string;
  hosts: string[];
  pilotHost: string;
  previewToken?: string;
};

const PREVIEW_COOKIE = "auscii_preview";

export function productionCaddyBlock({ slug, hosts, pilotHost }: CaddySiteInput): string {
  return `${hosts.join(", ")} {
	root * /srv/sites/${slug}/current
	encode gzip zstd
	header -Server
	handle /__forms/* {
		reverse_proxy https://${pilotHost} {
			header_up Host ${pilotHost}
			header_up X-Site ${slug}
			header_up X-Forwarded-Host {host}
		}
	}
	handle {
		try_files {path} {path}/index.html {path}.html
		file_server
	}
	handle_errors {
		@notfound expression {http.error.status_code} == 404
		handle @notfound {
			root * /srv/sites/${slug}/current
			rewrite * /404.html
			file_server
		}
	}
}
`;
}

/** Same as production, behind a cookie gate: /__preview/<token> sets the cookie, otherwise "Accès réservé". */
export function previewCaddyBlock({
  slug,
  hosts,
  pilotHost,
  previewToken,
}: CaddySiteInput): string {
  if (!previewToken) throw new Error("previewToken is required for a preview block");
  return `${hosts.join(", ")} {
	root * /srv/sites/${slug}/current
	encode gzip zstd
	header -Server
	header X-Robots-Tag "noindex, nofollow"
	@enter path /__preview/${previewToken}
	handle @enter {
		header Set-Cookie "${PREVIEW_COOKIE}=${previewToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000"
		redir / 302
	}
	@authorized header_regexp Cookie ${PREVIEW_COOKIE}=${previewToken}
	handle @authorized {
		handle /__forms/* {
			reverse_proxy https://${pilotHost} {
				header_up Host ${pilotHost}
				header_up X-Site ${slug}
				header_up X-Site-Env preview
				header_up X-Forwarded-Host {host}
			}
		}
		handle {
			try_files {path} {path}/index.html {path}.html
			file_server
		}
	}
	handle {
		respond "Accès réservé. Utilisez le lien de prévisualisation transmis par AUSCII." 403
	}
}
`;
}

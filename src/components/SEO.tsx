import { Helmet } from "react-helmet-async";

export interface SEOProps {
  /** Page title - appears in browser tab and search results (under 60 chars recommended) */
  title?: string;
  /** Page description - appears in search results (150-160 chars recommended) */
  description?: string;
  /** Image URL for social sharing. Can be relative (/image.png) or absolute. */
  image?: string;
  /** Canonical URL of the page */
  url?: string;
  /** Set to true to prevent search engines from indexing this page */
  noindex?: boolean;
  /** Site name for Open Graph */
  siteName?: string;
}

/**
 * Converts a relative URL to an absolute URL using the current origin.
 */
function toAbsoluteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  if (typeof window !== "undefined") {
    return `${window.location.origin}${url.startsWith("/") ? "" : "/"}${url}`;
  }
  return url;
}

/**
 * SEO component for setting page meta tags.
 *
 * @example
 * <SEO
 *   title="My Site - Welcome"
 *   description="A brief description of my site."
 *   url="https://mysite.com/"
 * />
 */
export function SEO({
  title,
  description,
  image,
  url,
  noindex = false,
  siteName,
}: SEOProps) {
  const absoluteImageUrl = toAbsoluteUrl(image);
  const absoluteUrl = toAbsoluteUrl(url);

  return (
    <Helmet>
      {/* Basic meta tags */}
      {title && <title>{title}</title>}
      {description && <meta name="description" content={description} />}
      {noindex && <meta name="robots" content="noindex, nofollow" />}
      {absoluteUrl && <link rel="canonical" href={absoluteUrl} />}

      {/* Open Graph */}
      {title && <meta property="og:title" content={title} />}
      {description && <meta property="og:description" content={description} />}
      {absoluteImageUrl && <meta property="og:image" content={absoluteImageUrl} />}
      {absoluteUrl && <meta property="og:url" content={absoluteUrl} />}
      <meta property="og:type" content="website" />
      {siteName && <meta property="og:site_name" content={siteName} />}

      {/* Twitter */}
      <meta name="twitter:card" content="summary" />
    </Helmet>
  );
}

export { Helmet } from "react-helmet-async";

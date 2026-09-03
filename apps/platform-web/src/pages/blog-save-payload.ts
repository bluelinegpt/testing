/** Match SaveBlogArticleDto exactly: never send response metadata back as input. */
export function blogSavePayload(form: Record<string, any>) {
  return {
    slug: form.slug, language: form.language, title: form.title, excerpt: form.excerpt,
    content: [{ type: "html", text: String(form.content ?? "") }],
    authorId: form.authorId, categoryId: form.categoryId,
    robotsIndex: form.robotsIndex, robotsFollow: form.robotsFollow,
    seoTitle: form.seoTitle, metaDescription: form.metaDescription,
    socialTitle: form.socialTitle, socialDescription: form.socialDescription,
    ...(form.featuredImagePublicUrl ? { featuredImagePublicUrl: form.featuredImagePublicUrl, featuredImageAlt: form.featuredImageAlt } : {}),
    ...(form.canonicalUrl ? { canonicalUrl: form.canonicalUrl } : {}),
    ...(form.socialImageUrl ? { socialImageUrl: form.socialImageUrl } : {}),
  };
}

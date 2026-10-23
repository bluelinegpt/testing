import { afterEach, describe, expect, it, vi } from "vitest";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { WebsiteCmsService } from "./website-cms.service.js";

const db = new Kysely({ dialect: {
  createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(),
  createIntrospector: (database) => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler(),
}});
afterEach(()=>vi.restoreAllMocks());
const article={slug:"create-an-order",locale:"en",canonical_path:"/resources/create-an-order",robots_index:true,related_slugs:[]};
function serviceWith(rows: unknown[][]) {
  const execute = vi.spyOn(db.getExecutor(),"executeQuery");
  for (const result of rows) execute.mockResolvedValueOnce({rows:result});
  return new WebsiteCmsService(db as never, {} as never, {get:()=>"local"} as never);
}
describe("published Help translations",()=>{
  it("keeps untranslated Arabic fallback consolidated and noindex",async()=>{
    const service=serviceWith([[article],[],[{locale:"en",canonical_path:article.canonical_path,robots_index:true}]]);
    const result=await service.helpArticle(article.slug,"ar");
    expect(result.article.canonical_path).toBe(article.canonical_path);
    expect(result.article.robots_index).toBe(false);
    expect(result.article.alternates).toEqual([{language:"en",url:"https://tawseelhub.com/resources/create-an-order"}]);
  });
  it("emits reciprocal alternates for published, self-canonical translations",async()=>{
    const ar={...article,locale:"ar",canonical_path:"/ar/resources/create-an-order"};
    const versions=[article,ar];
    for(const row of versions){
      const service=serviceWith([[row],[],versions]);
      const result=await service.helpArticle(article.slug,row.locale);
      expect(result.article.robots_index).toBe(true);
      expect(result.article.canonical_path).toBe(row.canonical_path);
      expect(result.article.alternates.map((x: {language: string})=>x.language)).toEqual(["en","ar"]);
    }
  });
  it("does not advertise a noindex or canonicalized-away translation",async()=>{
    const service=serviceWith([[article],[],[article,{...article,locale:"ar",robots_index:false},{...article,locale:"ar",canonical_path:"/resources/create-an-order"}]]);
    const result=await service.helpArticle(article.slug,"en");
    expect(result.article.alternates).toHaveLength(1);
  });
});

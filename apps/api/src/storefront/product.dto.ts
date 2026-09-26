import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

import {
  productAvailabilityStatuses,
  productLifecycleStatuses,
  productMediaTypes,
  productSortColumns,
  publicProductSortColumns,
} from "./product.constants.js";

/**
 * Product Catalogue request contracts.
 *
 * Money arrives as a STRING and is validated by pattern, never bound to a
 * JavaScript number: a price that round-trips through a float is a price that
 * can disagree with the ledger. Sort fields are constrained to the allow-list
 * the service maps to SQL, so no caller-supplied text reaches an ORDER BY.
 */

const moneyPattern = /^\d{1,10}(\.\d{1,2})?$/;

export class CategoryWriteDto {
  @ApiProperty({ example: "Abayas" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  public nameEn!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public nameAr?: string | null;

  @ApiPropertyOptional({ example: "abayas" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(63)
  public slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(600)
  public description?: string | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public displayOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public imageFileId?: string | null;
}

export class UpdateCategoryDto extends CategoryWriteDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  public expectedVersion!: number;
}

export class CategoryStatusDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  public expectedVersion!: number;

  @ApiProperty()
  @IsBoolean()
  public isActive!: boolean;
}

export class ReorderEntryDto {
  @ApiProperty()
  @IsUUID()
  public id!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public displayOrder!: number;
}

export class ReorderDto {
  @ApiProperty({ type: () => [ReorderEntryDto] })
  @Type(() => ReorderEntryDto)
  public entries!: ReorderEntryDto[];
}

export class CreateProductDto {
  @ApiProperty()
  @IsUUID()
  public storefrontId!: string;

  @ApiProperty({ example: "Embroidered Abaya" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public name!: string;

  @ApiPropertyOptional({ example: "embroidered-abaya" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(96)
  public slug?: string;

  @ApiProperty({ example: "ABAYA-0001" })
  @IsString()
  @MinLength(1)
  @MaxLength(48)
  public productCode!: string;

  @ApiProperty({ example: "249.00", description: "AED, greater than zero" })
  @Matches(moneyPattern, { message: "product_price_invalid" })
  public sellingPrice!: string;

  @ApiPropertyOptional({ example: "299.00" })
  @IsOptional()
  @Matches(moneyPattern, { message: "product_price_invalid" })
  public previousPrice?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public categoryId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  public shortDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  public fullDescription?: string | null;

  // SKU and barcode are declared as strings and validated as strings. A numeric
  // type here would drop the leading zero of '0012345678905' before the service
  // ever saw it.
  @ApiPropertyOptional({ example: "ABA-01" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public sku?: string | null;

  @ApiPropertyOptional({ example: "0012345678905" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public barcode?: string | null;

  @ApiPropertyOptional({ example: "Al Noor" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public brand?: string | null;
}

export class UpdateProductDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  public expectedVersion!: number;

  /**
   * SEO overrides.
   *
   * Optional throughout: the metadata layer already builds a title from the
   * Product and Store names and a description from the short description, so a
   * Trader who never touches this still gets correct, honest metadata. Null
   * clears an override and restores the derived value; a blank string is
   * rejected by the database rather than published as an empty title.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public seoTitleEn?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public seoTitleAr?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  public seoDescriptionEn?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  public seoDescriptionAr?: string | null;

  @ApiPropertyOptional({ description: "Existing uploaded file reference" })
  @IsOptional()
  @IsUUID()
  public seoSocialFileId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  public seoIndexable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(96)
  public slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(48)
  public productCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(moneyPattern, { message: "product_price_invalid" })
  public sellingPrice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(moneyPattern, { message: "product_price_invalid" })
  public previousPrice?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public categoryId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  public shortDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  public fullDescription?: string | null;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  public minimumQuantity?: number | null;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  public maximumQuantity?: number | null;

  @ApiPropertyOptional({
    description: "Template-specific attributes, validated against an allow-list",
  })
  @IsOptional()
  @IsObject()
  public templateAttributes?: Record<string, unknown>;

  @ApiPropertyOptional({ example: "ABA-01" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public sku?: string | null;

  @ApiPropertyOptional({ example: "0012345678905" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public barcode?: string | null;

  @ApiPropertyOptional({ example: "Al Noor" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public brand?: string | null;
}

export class ProductStatusDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  public expectedVersion!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public reason?: string;
}

export class ProductAvailabilityDto extends ProductStatusDto {
  @ApiProperty({ enum: productAvailabilityStatuses })
  @IsIn(productAvailabilityStatuses)
  public availabilityStatus!: (typeof productAvailabilityStatuses)[number];
}

export class ProductMediaDto {
  @ApiProperty({ enum: productMediaTypes })
  @IsIn(productMediaTypes)
  public mediaType!: (typeof productMediaTypes)[number];

  @ApiPropertyOptional({ description: "Preferred: an existing uploaded file reference" })
  @IsOptional()
  @IsUUID()
  public fileId?: string;

  @ApiPropertyOptional({ description: "https or storage-relative reference" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public mediaUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public posterFileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public posterUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public altText?: string | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public displayOrder?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  public isPrimary?: boolean;
}

export class UpdateMediaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public altText?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public displayOrder?: number;
}

export class OptionGroupDto {
  @ApiProperty({ example: "Size" })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public name!: string;

  @ApiPropertyOptional({
    default: false,
    description: "A required group must have at least one active value before activation",
  })
  @IsOptional()
  @IsBoolean()
  public isRequired?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public displayOrder?: number;
}

export class OptionValueDto {
  @ApiProperty({ example: "M" })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public value!: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public displayOrder?: number;
}

export class OptionActiveDto {
  @ApiProperty()
  @IsBoolean()
  public isActive!: boolean;
}

export class OptionValueUpdateDto {
  @ApiProperty({ example: "Dark Navy" })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public value!: string;
}

export class OptionGroupUpdateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public isRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public name?: string;
}

export class ProductListQueryDto {
  @ApiProperty()
  @IsUUID()
  public storefrontId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public categoryId?: string;

  @ApiPropertyOptional({ enum: productLifecycleStatuses })
  @IsOptional()
  @IsIn(productLifecycleStatuses)
  public lifecycleStatus?: (typeof productLifecycleStatuses)[number];

  @ApiPropertyOptional({ enum: productAvailabilityStatuses })
  @IsOptional()
  @IsIn(productAvailabilityStatuses)
  public availabilityStatus?: (typeof productAvailabilityStatuses)[number];

  @ApiPropertyOptional({ enum: Object.keys(productSortColumns) })
  @IsOptional()
  @IsIn(Object.keys(productSortColumns))
  public sortBy?: string;

  @ApiPropertyOptional({ enum: ["asc", "desc"] })
  @IsOptional()
  @IsIn(["asc", "desc"])
  public sortDirection?: "asc" | "desc";

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public pageSize?: number;
}

export class PublicProductListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(63)
  public category?: string;

  @ApiPropertyOptional({ enum: Object.keys(publicProductSortColumns) })
  @IsOptional()
  @IsIn(Object.keys(publicProductSortColumns))
  public sortBy?: string;

  @ApiPropertyOptional({ enum: ["asc", "desc"] })
  @IsOptional()
  @IsIn(["asc", "desc"])
  public sortDirection?: "asc" | "desc";

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  // A public endpoint bounds its own page size: an unbounded one is a cheap
  // way to make the database do expensive work from the open internet.
  @ApiPropertyOptional({ default: 24, maximum: 48 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  public pageSize?: number;
}

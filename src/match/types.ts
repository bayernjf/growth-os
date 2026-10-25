// growth-os G5 matching engine domain types (buyer demands / supplier offers /
// matches). A match pairs a buyer demand with a supplier offer and carries an
// explainable score.

export type DemandStatus = 'new' | 'matched' | 'closed';
export type MatchStatus = 'pending' | 'accepted' | 'rejected';

export interface BuyerDemand {
  id: string;
  title: string;
  category: string;
  quantity?: string;
  priceMin?: number;
  priceMax?: number;
  currency: string;
  deadline?: string;
  region?: string;
  description: string;
  sourceSignalId?: string;
  status: DemandStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BuyerDemandInput {
  title: string;
  category: string;
  quantity?: string;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  deadline?: string;
  region?: string;
  description?: string;
  sourceSignalId?: string;
}

export interface SupplierOffer {
  id: string;
  title: string;
  category: string;
  capacity?: string;
  price?: number;
  currency: string;
  moq?: number;
  region?: string;
  credentials?: string;
  description: string;
  sourceSignalId?: string;
  status: DemandStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierOfferInput {
  title: string;
  category: string;
  capacity?: string;
  price?: number;
  currency?: string;
  moq?: number;
  region?: string;
  credentials?: string;
  description?: string;
  sourceSignalId?: string;
}

export interface Match {
  id: string;
  buyerDemandId: string;
  supplierOfferId: string;
  score: number;
  reasons: Record<string, number>;
  status: MatchStatus;
  createdAt: string;
  updatedAt: string;
}

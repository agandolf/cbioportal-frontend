import {
    DiscreteCopyNumberFilter, DiscreteCopyNumberData, ClinicalData, ClinicalDataMultiStudyFilter, Sample,
    SampleIdentifier, MolecularProfile, Mutation, NumericGeneMolecularData, MolecularDataFilter, Gene,
    ClinicalDataSingleStudyFilter, CancerStudy, PatientIdentifier, Patient, GenePanelData, GenePanelDataFilter,
    SampleList, MutationCountByPosition, MutationMultipleStudyFilter, SampleMolecularIdentifier,
    MolecularDataMultipleStudyFilter, SampleFilter, MolecularProfileFilter, GenePanelMultipleStudyFilter, PatientFilter
} from "shared/api/generated/CBioPortalAPI";
import client from "shared/api/cbioportalClientInstance";
import {computed, observable, action, reaction, IObservable, IObservableValue, ObservableMap} from "mobx";
import {remoteData, addErrorHandler} from "shared/api/remoteData";
import {labelMobxPromises, cached, MobxPromise} from "mobxpromise";
import OncoKbEvidenceCache from "shared/cache/OncoKbEvidenceCache";
import PubMedCache from "shared/cache/PubMedCache";
import CancerTypeCache from "shared/cache/CancerTypeCache";
import MutationCountCache from "shared/cache/MutationCountCache";
import DiscreteCNACache from "shared/cache/DiscreteCNACache";
import GenomeNexusEnrichmentCache from "shared/cache/GenomeNexusEnrichment";
import PdbHeaderCache from "shared/cache/PdbHeaderCache";
import {
    findMolecularProfileIdDiscrete, fetchMyCancerGenomeData,
    fetchDiscreteCNAData, findMutationMolecularProfileId, mergeDiscreteCNAData,
    fetchSamples, fetchClinicalDataInStudy, generateDataQueryFilter,
    fetchSamplesWithoutCancerTypeClinicalData, fetchStudiesForSamplesWithoutCancerTypeClinicalData, IDataQueryFilter,
    isMutationProfile, fetchOncoKbAnnotatedGenes, groupBy, fetchOncoKbData,
    ONCOKB_DEFAULT, generateUniqueSampleKeyToTumorTypeMap, cancerTypeForOncoKb, fetchCnaOncoKbData,
    fetchCnaOncoKbDataWithNumericGeneMolecularData, fetchGermlineConsentedSamples
} from "shared/lib/StoreUtils";
import {indexHotspotsData, fetchHotspotsData} from "shared/lib/CancerHotspotsUtils";
import {MutationMapperStore} from "./mutation/MutationMapperStore";
import AppConfig from "appConfig";
import * as _ from 'lodash';
import {stringListToIndexSet, stringListToSet} from "../../shared/lib/StringUtils";
import {toSampleUuid} from "../../shared/lib/UuidUtils";
import MutationDataCache from "../../shared/cache/MutationDataCache";
import accessors, {getSimplifiedMutationType, SimplifiedMutationType} from "../../shared/lib/oql/accessors";
import {filterCBioPortalWebServiceData} from "../../shared/lib/oql/oqlfilter.js";
import {keepAlive} from "mobx-utils";
import MutationMapper from "./mutation/MutationMapper";
import {CacheData} from "../../shared/lib/LazyMobXCache";
import {
    IAlterationCountMap,
    IAlterationData
} from "./cancerSummary/CancerSummaryContent";
import {writeTest} from "../../shared/lib/writeTest";
import {PatientSurvival} from "../../shared/model/PatientSurvival";
import {filterCBioPortalWebServiceDataByOQLLine, OQLLineFilterOutput} from "../../shared/lib/oql/oqlfilter";
import GeneMolecularDataCache from "../../shared/cache/GeneMolecularDataCache";
import GenesetMolecularDataCache from "../../shared/cache/GenesetMolecularDataCache";
import GenesetCorrelatedGeneCache from "../../shared/cache/GenesetCorrelatedGeneCache";
import GeneCache from "../../shared/cache/GeneCache";
import ClinicalDataCache from "../../shared/cache/ClinicalDataCache";
import {IHotspotIndex} from "../../shared/model/CancerHotspots";
import {IOncoKbData} from "../../shared/model/OncoKB";
import {generateQueryVariantId} from "../../shared/lib/OncoKbUtils";
import {CosmicMutation} from "../../shared/api/generated/CBioPortalAPIInternal";
import internalClient from "../../shared/api/cbioportalInternalClientInstance";
import {IndicatorQueryResp} from "../../shared/api/generated/OncoKbAPI";
import {getAlterationString} from "../../shared/lib/CopyNumberUtils";
import {isRecurrentHotspot} from "../../shared/lib/AnnotationUtils";
import memoize from "memoize-weak-decorator";
import request from 'superagent';
import {countMutations, mutationCountByPositionKey} from "./mutationCountHelpers";
import {getPatientSurvivals} from "./SurvivalStoreHelper";
import {QueryStore} from "shared/components/query/QueryStore";
import {
    annotateMolecularDatum, getOncoKbOncogenic,
    computeCustomDriverAnnotationReport, computePutativeDriverAnnotatedMutations,
    initializeCustomDriverAnnotationSettings, computeGenePanelInformation,
    getQueriedStudies
} from "./ResultsViewPageStoreUtils";
import {getAlterationCountsForCancerTypesForAllGenes} from "../../shared/lib/alterationCountHelpers";
import sessionServiceClient from "shared/api//sessionServiceInstance";
import { VirtualStudy } from "shared/model/VirtualStudy";

type Optional<T> = (
    {isApplicable: true, value: T}
    | {isApplicable: false, value?: undefined}
);

export type SamplesSpecificationElement = {studyId: string, sampleId: string, sampleListId: undefined} |
    {studyId: string, sampleId: undefined, sampleListId: string};

export const AlterationTypeConstants = {
    MUTATION_EXTENDED: 'MUTATION_EXTENDED',
    COPY_NUMBER_ALTERATION: 'COPY_NUMBER_ALTERATION',
    MRNA_EXPRESSION: 'MRNA_EXPRESSION',
    PROTEIN_LEVEL: 'PROTEIN_LEVEL',
    FUSION: 'FUSION',
    GENESET_SCORE: 'GENESET_SCORE',
    METHYLATION: 'METHYLATION'
}

export interface ExtendedAlteration extends Mutation, NumericGeneMolecularData {
    molecularProfileAlterationType: MolecularProfile["molecularAlterationType"];
    // TODO: what is difference molecularProfileAlterationType and
    // alterationType?
    alterationType: string
    alterationSubType: string
};

export interface AnnotatedMutation extends Mutation {
    putativeDriver: boolean;
    oncoKbOncogenic:string;
    isHotspot:boolean;
    simplifiedMutationType: SimplifiedMutationType;
}

export interface AnnotatedNumericGeneMolecularData extends NumericGeneMolecularData {
    oncoKbOncogenic: string;
}

export interface AnnotatedExtendedAlteration extends ExtendedAlteration, AnnotatedMutation, AnnotatedNumericGeneMolecularData {};

export interface ExtendedSample extends Sample {
    cancerType: string;
    cancerTypeDetailed: string;
}

export type CaseAggregatedData<T> = {
    samples: {[uniqueSampleKey:string]:T[]};
    patients: {[uniquePatientKey:string]:T[]};
};

export type GenePanelInformation = {
    samples:
        {[uniqueSampleKey:string]:{
            sequencedGenes:{[hugoGeneSymbol:string]:GenePanelData[]},
            wholeExomeSequenced: boolean
        }};
    patients:
        {[uniquePatientKey:string]:{
            sequencedGenes:{[hugoGeneSymbol:string]:GenePanelData[]},
            wholeExomeSequenced: boolean
        }};
};

export function buildDefaultOQLProfile(profilesTypes: string[], zScoreThreshold: number, rppaScoreThreshold: number) {

    var default_oql_uniq: any = {};
    for (var i = 0; i < profilesTypes.length; i++) {
        var type = profilesTypes[i];
        switch (type) {
            case "MUTATION_EXTENDED":
                default_oql_uniq["MUT"] = true;
                default_oql_uniq["FUSION"] = true;
                break;
            case "COPY_NUMBER_ALTERATION":
                default_oql_uniq["AMP"] = true;
                default_oql_uniq["HOMDEL"] = true;
                break;
            case "MRNA_EXPRESSION":
                default_oql_uniq["EXP>=" + zScoreThreshold] = true;
                default_oql_uniq["EXP<=-" + zScoreThreshold] = true;
                break;
            case "PROTEIN_LEVEL":
                default_oql_uniq["PROT>=" + rppaScoreThreshold] = true;
                default_oql_uniq["PROT<=-" + rppaScoreThreshold] = true;
                break;
        }
    }
    return Object.keys(default_oql_uniq).join(" ");

}

export function extendSamplesWithCancerType(samples:Sample[], clinicalDataForSamples:ClinicalData[], studies:CancerStudy[]){

    const clinicalDataGroupedBySampleId = _.groupBy(clinicalDataForSamples, (clinicalData:ClinicalData)=>clinicalData.uniqueSampleKey);
    // note that this table is actually mutating underlying sample.  it's not worth it to clone samples just
    // for purity
    const extendedSamples = samples.map((sample: ExtendedSample)=>{
        const clinicalData = clinicalDataGroupedBySampleId[sample.uniqueSampleKey];
        if (clinicalData) {
            clinicalData.forEach((clinicalDatum:ClinicalData)=>{
                switch (clinicalDatum.clinicalAttributeId) {
                    case 'CANCER_TYPE_DETAILED':
                        sample.cancerTypeDetailed = clinicalDatum.value;
                        break;
                    case 'CANCER_TYPE':
                        sample.cancerType = clinicalDatum.value;
                        break;
                    default:
                        break;
                }
            });
        }
        return sample;
    });

    //make a map by studyId for easy access in following loop
    const studyMap = _.keyBy(studies,(study:CancerStudy)=>study.studyId);

    // now we need to fix any samples which do not have both cancerType and cancerTypeDetailed
    extendedSamples.forEach((sample:ExtendedSample)=>{
        //if we have no cancer subtype, then make the subtype the parent type
        if (!sample.cancerType) {
            // we need to fall back to studies cancerType
            const study = studyMap[sample.studyId];
            if (study) {
                sample.cancerType = study.cancerType.name;
            } else {
                sample.cancerType = "Unknown";
            }
        }
        if (sample.cancerType && !sample.cancerTypeDetailed) {
            sample.cancerTypeDetailed = sample.cancerType;
        }
    });

    return extendedSamples;

}

type MutationAnnotationSettings = {
    ignoreUnknown: boolean;
    cbioportalCount:boolean;
    cbioportalCountThreshold:number;
    cosmicCount:boolean;
    cosmicCountThreshold:number;
    driverFilter:boolean;
    driverTiers:ObservableMap<boolean>;
    hotspots:boolean;
    oncoKb:boolean;
};

/* fields and methods in the class below are ordered based on roughly
/* chronological setup concerns, rather than on encapsulation and public API */
/* tslint:disable: member-ordering */
export class ResultsViewPageStore {

    constructor() {
        labelMobxPromises(this);

        // addErrorHandler((error: any) => {
        //     this.ajaxErrors.push(error);
        // });
        this.getURL();

        const store = this;

        this.mutationAnnotationSettings = observable({
            cbioportalCount: false,
            cbioportalCountThreshold: 10,
            cosmicCount: false,
            cosmicCountThreshold: 10,
            driverFilter: !!AppConfig.oncoprintCustomDriverAnnotationDefault,
            driverTiers: observable.map<boolean>(),

            hotspots:!AppConfig.oncoprintOncoKbHotspotsDefault,
            _oncoKb:!AppConfig.oncoprintOncoKbHotspotsDefault,
            _ignoreUnknown: !!AppConfig.oncoprintHideVUSDefault,

            set oncoKb(val:boolean) {
                this._oncoKb = val;
            },
            get oncoKb() {
                return this._oncoKb && !store.didOncoKbFailInOncoprint;
            },
            set ignoreUnknown(val:boolean) {
                this._ignoreUnknown = val;
            },
            get ignoreUnknown() {
                const anySelected = store.mutationAnnotationSettings.oncoKb ||
                    store.mutationAnnotationSettings.hotspots ||
                    store.mutationAnnotationSettings.cbioportalCount ||
                    store.mutationAnnotationSettings.cosmicCount ||
                    store.mutationAnnotationSettings.driverFilter ||
                    store.mutationAnnotationSettings.driverTiers.entries().reduce((oneSelected, nextEntry)=>{
                        return oneSelected || nextEntry[1];
                    }, false);
                return this._ignoreUnknown && anySelected;
            }
        });
    }

    public queryStore: QueryStore;

    @observable public urlValidationError: string | null = null;

    @observable ajaxErrors: Error[] = [];

    @observable hugoGeneSymbols: string[];
    @observable genesetIds: string[];
    @observable samplesSpecification: SamplesSpecificationElement[] = [];

    //queried id(any combination of physical and virtual studies)
    @observable cohortIdsList: string[] = []

    @observable zScoreThreshold: number;

    @observable rppaScoreThreshold: number;

    @observable oqlQuery: string = '';
    @observable public sessionIdURL = '';

    @observable selectedMolecularProfileIds: string[] = [];

    public mutationAnnotationSettings:MutationAnnotationSettings;

    private getURL() {
        const shareURL = window.location.href;

        if (!shareURL.includes("session_id")) return;

        const showSamples = shareURL.indexOf("&show");
        if (showSamples > -1) {
            this.sessionIdURL = shareURL.slice(0, showSamples);
        }
    }

    readonly bitlyShortenedURL = remoteData({
        invoke: () => {
            return request.get('http://' + location.host + "/api/url-shortener?url=" + this.sessionIdURL);
        },
        onError: () => {
            //
        }
    });

    readonly selectedMolecularProfiles = remoteData<MolecularProfile[]>({
        await: ()=>[
          this.molecularProfilesInStudies
        ],
        invoke: () => {
            const idLookupMap = _.keyBy(this.selectedMolecularProfileIds,(id:string)=>id); // optimization
            return Promise.resolve(this.molecularProfilesInStudies.result!.filter((profile:MolecularProfile)=>(profile.molecularProfileId in idLookupMap)));
        }
    });

    readonly clinicalAttributes = remoteData({
        await:()=>[this.studyIds],
        invoke:async()=>{
            return client.fetchClinicalAttributesUsingPOST({
                studyIds:this.studyIds.result!
            });
        }
    });

    readonly molecularData = remoteData<NumericGeneMolecularData[]>({
        await: () => [
            this.studyToDataQueryFilter,
            this.genes,
            this.selectedMolecularProfiles,
            this.samples
        ],
        invoke: () => {

            // we get mutations with mutations endpoint, all other alterations with this one, so filter out mutation genetic profile
            const profilesWithoutMutationProfile = _.filter(this.selectedMolecularProfiles.result, (profile: MolecularProfile) => profile.molecularAlterationType !== 'MUTATION_EXTENDED');
            const genes = this.genes.result;

            if (profilesWithoutMutationProfile.length && genes != undefined && genes.length) {

                const identifiers : SampleMolecularIdentifier[] = [];

                profilesWithoutMutationProfile.forEach((profile:MolecularProfile)=>{
                    // for each profile, find samples which share studyId with profile and add identifier
                    this.samples.result.forEach((sample:Sample)=>{
                        if (sample.studyId === profile.studyId) {
                            identifiers.push({ molecularProfileId:profile.molecularProfileId, sampleId:sample.sampleId })
                        }
                    });
                });

                return client.fetchMolecularDataInMultipleMolecularProfilesUsingPOST({
                    projection:'DETAILED',
                    molecularDataMultipleStudyFilter:({
                        entrezGeneIds: _.map(this.genes.result,(gene:Gene)=>gene.entrezGeneId),
                        sampleMolecularIdentifiers:identifiers
                    } as MolecularDataMultipleStudyFilter)
                });

            } else {
                return Promise.resolve([]);
            }
        }
    });

    readonly unfilteredAlterations = remoteData<(Mutation|NumericGeneMolecularData)[]>({
        await: ()=>[
            this.mutations,
            this.molecularData
        ],
        invoke: ()=>{
            let result:(Mutation|NumericGeneMolecularData)[] = [];
            result = result.concat(this.mutations.result!);
            result = result.concat(this.molecularData.result!);
            return Promise.resolve(result);
        }
    });

    readonly unfilteredExtendedAlterations = remoteData<ExtendedAlteration[]>({
        await: ()=>[
            this.unfilteredAlterations,
            this.selectedMolecularProfiles,
            this.defaultOQLQuery
        ],
        invoke: () => {
            const acc = new accessors(this.selectedMolecularProfiles.result!);
            const alterations: ExtendedAlteration[] = [];

            this.unfilteredAlterations.result!.forEach(alteration => {
                const extendedAlteration: Partial<ExtendedAlteration> = {
                    molecularProfileAlterationType: acc.molecularAlterationType(alteration.molecularProfileId),
                    ...Object.assign({}, alteration)
                };

                alterations.push(extendedAlteration as ExtendedAlteration);
            });

            return Promise.resolve(alterations);
        }
    });

    readonly filteredAlterations = remoteData<ExtendedAlteration[]>({
        await:()=>[
            this.unfilteredAlterations,
            this.selectedMolecularProfiles,
            this.defaultOQLQuery
        ],
        invoke:()=>{
            if (this.oqlQuery.trim() != "") {
                return Promise.resolve(
                        filterCBioPortalWebServiceData(this.oqlQuery, this.unfilteredAlterations.result!, (new accessors(this.selectedMolecularProfiles.result!)), this.defaultOQLQuery.result!)
                );
            } else {
                return Promise.resolve([]);
            }
        }
    });

    readonly filteredAlterationsByOQLLine = remoteData<OQLLineFilterOutput<ExtendedAlteration>[]>({
        await: ()=>[
            this.unfilteredAlterations,
            this.selectedMolecularProfiles,
            this.defaultOQLQuery
        ],
        invoke: ()=>{
            return Promise.resolve(filterCBioPortalWebServiceDataByOQLLine(this.oqlQuery, this.unfilteredAlterations.result!,
                (new accessors(this.selectedMolecularProfiles.result!)), this.defaultOQLQuery.result!));
        }
    });

    readonly caseAggregatedData = remoteData<CaseAggregatedData<ExtendedAlteration>>({
        await: ()=>[
            this.filteredAlterations,
            this.samples,
            this.patients
        ],
        invoke: ()=>{
            return Promise.resolve({
                samples:
                    groupBy(this.filteredAlterations.result!, alteration=>alteration.uniqueSampleKey, this.samples.result!.map(sample=>sample.uniqueSampleKey)),
                patients:
                    groupBy(this.filteredAlterations.result!, alteration=>alteration.uniquePatientKey, this.patients.result!.map(sample=>sample.uniquePatientKey))
            });
        }
    });

    readonly unfilteredCaseAggregatedData = remoteData<CaseAggregatedData<ExtendedAlteration>>({
        await: ()=>[
            this.unfilteredExtendedAlterations,
            this.samples,
            this.patients
        ],
        invoke: ()=>{
            return Promise.resolve({
                samples:
                    groupBy(this.unfilteredExtendedAlterations.result!, alteration=>alteration.uniqueSampleKey, this.samples.result!.map(sample=>sample.uniqueSampleKey)),
                patients:
                    groupBy(this.unfilteredExtendedAlterations.result!, alteration=>alteration.uniquePatientKey, this.patients.result!.map(sample=>sample.uniquePatientKey))
            });
        }
    });

    readonly putativeDriverFilteredCaseAggregatedDataByOQLLine = remoteData<{cases:CaseAggregatedData<AnnotatedExtendedAlteration>, oql:OQLLineFilterOutput<AnnotatedExtendedAlteration>}[]>({
        await:()=>[
            this.putativeDriverAnnotatedMutations,
            this.annotatedMolecularData,
            this.selectedMolecularProfiles,
            this.defaultOQLQuery,
            this.samples,
            this.patients
        ],
        invoke:()=>{
            let unfilteredAlterations:(AnnotatedMutation | AnnotatedNumericGeneMolecularData)[] = [];
            unfilteredAlterations = unfilteredAlterations.concat(this.putativeDriverAnnotatedMutations.result!);
            unfilteredAlterations = unfilteredAlterations.concat(this.annotatedMolecularData.result!);

            if (this.oqlQuery.trim() != "") {
                const filteredAlterationsByOQLLine:OQLLineFilterOutput<AnnotatedExtendedAlteration>[] = filterCBioPortalWebServiceDataByOQLLine(this.oqlQuery, unfilteredAlterations,
                        (new accessors(this.selectedMolecularProfiles.result!)), this.defaultOQLQuery.result!);

                    return Promise.resolve(filteredAlterationsByOQLLine.map(oql=>{
                        const cases:CaseAggregatedData<AnnotatedExtendedAlteration> = {
                            samples:
                                groupBy(oql.data, datum=>datum.uniqueSampleKey, this.samples.result!.map(sample=>sample.uniqueSampleKey)),
                            patients:
                                groupBy(oql.data, datum=>datum.uniquePatientKey, this.patients.result!.map(sample=>sample.uniquePatientKey))
                        };
                        return {
                            cases,
                            oql
                        };
                    }));
            } else {
                return Promise.resolve([]);
            }
        }
    });

    readonly genePanelInformation = remoteData<GenePanelInformation>({
        await:()=>[
            this.studyToMutationMolecularProfile,
            this.genes,
            this.samples,
            this.patients
        ],
        invoke:async()=>{
            const studyToMutationMolecularProfile = this.studyToMutationMolecularProfile.result!;
            const sampleMolecularIdentifiers:SampleMolecularIdentifier[] = [];
            this.samples.result!.forEach(sample=>{
                const profile = studyToMutationMolecularProfile[sample.studyId];
                if (profile) {
                    sampleMolecularIdentifiers.push({
                        molecularProfileId: profile.molecularProfileId,
                        sampleId: sample.sampleId
                    });
                }
            });
            const entrezGeneIds = this.genes.result!.map(gene=>gene.entrezGeneId);
            let genePanelData:GenePanelData[];
            if (sampleMolecularIdentifiers.length && entrezGeneIds.length) {
                genePanelData = await client.fetchGenePanelDataInMultipleMolecularProfilesUsingPOST({
                    genePanelMultipleStudyFilter:{
                        sampleMolecularIdentifiers
                    }
                });
            } else {
                genePanelData = [];
            }

            const genePanelIds = _.uniq(genePanelData.map(gpData=>gpData.genePanelId));
            const genePanels = await client.fetchGenePanelsUsingPOST({
                genePanelIds,
                projection:"DETAILED"
            });
            return computeGenePanelInformation(genePanelData, genePanels, this.samples.result!, this.patients.result!, this.genes.result!);
        }
    });

    readonly sequencedSampleKeys = remoteData<string[]>({
        await:()=>[
            this.samples,
            this.genePanelInformation
        ],
        invoke:()=>{
            const genePanelInformation = this.genePanelInformation.result!;
            return Promise.resolve(this.samples.result!.map(s=>s.uniqueSampleKey).filter(k=>{
                const sequencedInfo = genePanelInformation.samples[k];
                return sequencedInfo.wholeExomeSequenced || !!Object.keys(sequencedInfo.sequencedGenes).length;
            }));
        }
    });

    readonly sequencedPatientKeys = remoteData<string[]>({
        await:()=>[
            this.patients,
            this.genePanelInformation
        ],
        invoke:()=>{
            const genePanelInformation = this.genePanelInformation.result!;
            return Promise.resolve(this.patients.result!.map(p=>p.uniquePatientKey).filter(k=>{
                const sequencedInfo = genePanelInformation.patients[k];
                return sequencedInfo.wholeExomeSequenced || !!Object.keys(sequencedInfo.sequencedGenes).length;
            }));
        }
    });

    readonly sequencedSampleKeysByGene = remoteData<{[hugoGeneSymbol:string]:string[]}>({
        await: ()=>[
            this.samples,
            this.genes,
            this.genePanelInformation
        ],
        invoke:()=>{
            const genePanelInformation = this.genePanelInformation.result!;
            return Promise.resolve(this.genes.result!.reduce((map:{[hugoGeneSymbol:string]:string[]}, next:Gene)=>{
                map[next.hugoGeneSymbol] = this.samples.result!.map(s=>s.uniqueSampleKey).filter(k=>{
                    const sequencedInfo = genePanelInformation.samples[k];
                    return (sequencedInfo.wholeExomeSequenced || sequencedInfo.sequencedGenes.hasOwnProperty(next.hugoGeneSymbol));
                });
                return map;
            }, {}));
        }
    });

    readonly sequencedPatientKeysByGene = remoteData<{[hugoGeneSymbol:string]:string[]}>({
        await: ()=>[
            this.patients,
            this.genes,
            this.genePanelInformation
        ],
        invoke:()=>{
            const genePanelInformation = this.genePanelInformation.result!;
            return Promise.resolve(this.genes.result!.reduce((map:{[hugoGeneSymbol:string]:string[]}, next:Gene)=>{
                map[next.hugoGeneSymbol] = this.patients.result!.map(p=>p.uniquePatientKey).filter(k=>{
                    const sequencedInfo = genePanelInformation.patients[k];
                    return (sequencedInfo.wholeExomeSequenced || sequencedInfo.sequencedGenes.hasOwnProperty(next.hugoGeneSymbol));
                });
                return map;
            }, {}));
        }
    });

    readonly alteredSampleKeys = remoteData({
        await:()=>[
            this.samples,
            this.caseAggregatedData
        ],
        invoke:()=>{
            const caseAggregatedData = this.caseAggregatedData.result!;
            return Promise.resolve(
                this.samples.result!.map(s=>s.uniqueSampleKey).filter(sampleKey=>!!caseAggregatedData.samples[sampleKey].length)
            );
        }
    });

    readonly alteredPatientKeys = remoteData({
        await:()=>[
            this.patients,
            this.caseAggregatedData
        ],
        invoke:()=>{
            const caseAggregatedData = this.caseAggregatedData.result!;
            return Promise.resolve(
                this.patients.result!.map(s=>s.uniquePatientKey).filter(patientKey=>!!caseAggregatedData.patients[patientKey].length)
            );
        }
    });

    readonly unalteredSampleKeys = remoteData({
        await:()=>[
            this.samples,
            this.caseAggregatedData
        ],
        invoke:()=>{
            const caseAggregatedData = this.caseAggregatedData.result!;
            return Promise.resolve(
                this.samples.result!.map(s=>s.uniqueSampleKey).filter(sampleKey=>!caseAggregatedData.samples[sampleKey].length)
            );
        }
    });

    readonly unalteredPatientKeys = remoteData({
        await:()=>[
            this.patients,
            this.caseAggregatedData
        ],
        invoke:()=>{
            const caseAggregatedData = this.caseAggregatedData.result!;
            return Promise.resolve(
                this.patients.result!.map(s=>s.uniquePatientKey).filter(patientKey=>!caseAggregatedData.patients[patientKey].length)
            );
        }
    });

    readonly filteredAlterationsByGene = remoteData<{[hugoGeneSymbol:string]:ExtendedAlteration[]}>({
        await: () => [
            this.genes,
            this.filteredAlterations
        ],
        invoke: () => {
            // first group them by gene symbol
            const groupedGenesMap = _.groupBy(this.filteredAlterations.result!, alteration=>alteration.gene.hugoGeneSymbol);
            // kind of ugly but this fixes a bug where sort order of genes not respected
            // yes we are relying on add order of js map. in theory not guaranteed, in practice guaranteed
            const ret = this.genes.result!.reduce((memo:{[hugoGeneSymbol:string]:ExtendedAlteration[]}, gene:Gene)=>{
                memo[gene.hugoGeneSymbol] = groupedGenesMap[gene.hugoGeneSymbol];
                return memo;
            },{});

            return Promise.resolve(ret);
        }
    });


    readonly defaultOQLQuery = remoteData({
        await: () => [this.selectedMolecularProfiles],
        invoke: () => {
            const profileTypes = _.map(this.selectedMolecularProfiles.result, (profile) => profile.molecularAlterationType);
            return Promise.resolve(buildDefaultOQLProfile(profileTypes, this.zScoreThreshold, this.rppaScoreThreshold));
        }

    });

    readonly samplesByDetailedCancerType = remoteData<{[cancerType:string]:Sample[]}>({
        await: () => [
            this.samples,
            this.clinicalDataForSamples
        ],
        invoke: () => {
            let groupedSamples = this.groupSamplesByCancerType(this.clinicalDataForSamples.result,this.samples.result, 'CANCER_TYPE');
            if (_.size(groupedSamples) === 1) {
                groupedSamples = this.groupSamplesByCancerType(this.clinicalDataForSamples.result, this.samples.result, 'CANCER_TYPE_DETAILED');
            }
            return Promise.resolve(groupedSamples);
        }
    });

    readonly samplesExtendedWithClinicalData = remoteData<ExtendedSample[]>({
        await: () => [
            this.samples,
            this.clinicalDataForSamples,
            this.studies
        ],
        invoke: () => {
            return Promise.resolve(extendSamplesWithCancerType(this.samples.result, this.clinicalDataForSamples.result,this.studies.result));
        }
    });

    public groupSamplesByCancerType(clinicalDataForSamples: ClinicalData[], samples: Sample[], cancerTypeLevel:'CANCER_TYPE' | 'CANCER_TYPE_DETAILED') {

        // first generate map of sampleId to it's cancer type
        const sampleKeyToCancerTypeClinicalDataMap = _.reduce(clinicalDataForSamples, (memo, clinicalData: ClinicalData) => {
            if (clinicalData.clinicalAttributeId === cancerTypeLevel) {
                memo[clinicalData.uniqueSampleKey] = clinicalData.value;
            }

            // if we were told CANCER_TYPE and we find CANCER_TYPE_DETAILED, then fall back on it. if we encounter
            // a CANCER_TYPE later, it will override this.
            if (cancerTypeLevel === 'CANCER_TYPE') {
                if (!memo[clinicalData.uniqueSampleKey] && clinicalData.clinicalAttributeId === 'CANCER_TYPE_DETAILED') {
                    memo[clinicalData.uniqueSampleKey] = clinicalData.value;
                }
            }

            return memo;
        }, {} as { [uniqueSampleId:string]:string });

        // now group samples by cancer type
        let samplesGroupedByCancerType = _.reduce(samples, (memo:{[cancerType:string]:Sample[]} , sample: Sample) => {
            // if it appears in map, then we have a cancer type
            if (sample.uniqueSampleKey in sampleKeyToCancerTypeClinicalDataMap) {
                memo[sampleKeyToCancerTypeClinicalDataMap[sample.uniqueSampleKey]] = memo[sampleKeyToCancerTypeClinicalDataMap[sample.uniqueSampleKey]] || [];
                memo[sampleKeyToCancerTypeClinicalDataMap[sample.uniqueSampleKey]].push(sample);
            } else {
                // TODO: we need to fall back to study cancer type
            }
            return memo;
        }, {} as { [cancerType:string]:Sample[] });

        return samplesGroupedByCancerType;
//
    }

    readonly alterationsByGeneBySampleKey = remoteData<{[hugoGeneSymbol:string]:{ [uniquSampleKey:string]:ExtendedAlteration[] }}>({
        await: () => [
            this.filteredAlterationsByGene,
            this.samples
        ],
        invoke: async() => {
            return _.mapValues(this.filteredAlterationsByGene.result, (alterations: ExtendedAlteration[]) => {
                return _.groupBy(alterations, (alteration: ExtendedAlteration) => alteration.uniqueSampleKey);
            });
        }
    });

    readonly totalAlterationStats = remoteData<{ alteredSampleCount:number, sampleCount:number }>({
       await:() => [
           this.alterationsByGeneBySampleKey,
           this.samplesExtendedWithClinicalData
       ],
       invoke: async ()=>{
           const countsByGroup = getAlterationCountsForCancerTypesForAllGenes(
               this.alterationsByGeneBySampleKey.result!,
               this.samplesExtendedWithClinicalData.result!,
               'cancerType');

           const ret = _.reduce(countsByGroup, (memo, alterationData:IAlterationData)=>{
                memo.alteredSampleCount += alterationData.alteredSampleCount;
                memo.sampleCount += alterationData.sampleTotal;
                return memo;
           }, { alteredSampleCount: 0, sampleCount:0 } as any);

           return ret;
       }
    });

    //contains all the physical studies for the current selected cohort ids
    //selected cohort ids can be any combination of physical_study_id and virtual_study_id(shared or saved ones)
    public get physicalStudySet():{ [studyId:string]:CancerStudy } {
        return _.keyBy(this.studies.result, (study:CancerStudy)=>study.studyId);
    }


    readonly filteredAlterationsByGeneAsSampleKeyArrays = remoteData({
        await: () => [
            this.filteredAlterationsByGene
        ],
        invoke: async() => {
            return _.mapValues(this.filteredAlterationsByGene.result, (mutations: Mutation[]) => _.map(mutations, mutation=>mutation.uniqueSampleKey));
        }
    });

    readonly filteredAlterationsAsUniquePatientKeyArrays = remoteData({
        await: () => [
            this.filteredAlterations
        ],
        invoke: async() => {
            return _.mapValues(this.filteredAlterations.result, (mutations: Mutation[]) => _.map(mutations, mutation => mutation.uniquePatientKey));
        }
    });

    readonly isSampleAlteredMap = remoteData({
        await: () => [this.filteredAlterationsByGeneAsSampleKeyArrays, this.samples],
        invoke: async() => {
            return _.mapValues(this.filteredAlterationsByGeneAsSampleKeyArrays.result, (sampleKeys: string[]) => {
                return this.samples.result.map((sample: Sample) => {
                    return _.includes(sampleKeys, sample.uniqueSampleKey);
                });
            });
        }
    });

    // readonly genes = remoteData(async() => {
    //     if (this.hugoGeneSymbols) {
    //         return client.fetchGenesUsingPOST({
    //             geneIds: this.hugoGeneSymbols.slice(),
    //             geneIdType: "HUGO_GENE_SYMBOL"
    //         });
    //     }
    //     return undefined;
    // });

    readonly givenSampleOrder = remoteData<Sample[]>({
        await: ()=>[
            this.samples
        ],
        invoke: async()=>{
            // for now, just assume we won't mix sample lists and samples in the specification
            if (this.samplesSpecification.find(x=>!x.sampleId)) {
                // for now, if theres any sample list id specification, then there is no given sample order
                return [];
            }
            // at this point, we know samplesSpecification is a list of samples
            const studyToSampleToIndex:{[studyId:string]:{[sampleId:string]:number}} =
                _.reduce(this.samplesSpecification,
                    (map:{[studyId:string]:{[sampleId:string]:number}}, next:SamplesSpecificationElement, index:number)=>{
                        map[next.studyId] = map[next.studyId] || {};
                        map[next.studyId][next.sampleId!] = index; // we know sampleId defined otherwise we would have returned from function already
                        return map;
                    },
                {});
            return _.sortBy(this.samples.result, sample=>studyToSampleToIndex[sample.studyId][sample.sampleId]);
        }
    });

    readonly studyToSampleIds = remoteData<{ [studyId: string]: { [sampleId: string]: boolean } }>(async () => {
        const sampleListsToQuery: { studyId: string, sampleListId: string }[] = [];
        const ret: { [studyId: string]: { [sampleId: string]: boolean } } = {};
        for (const sampleSpec of this.samplesSpecification) {
            if (sampleSpec.sampleId) {
                ret[sampleSpec.studyId] = ret[sampleSpec.studyId] || {};
                ret[sampleSpec.studyId][sampleSpec.sampleId] = true;
            } else if (sampleSpec.sampleListId) {
                sampleListsToQuery.push(sampleSpec as { studyId: string, sampleListId: string });
            }
        }
        const results: string[][] = await Promise.all(sampleListsToQuery.map(spec => {
            return client.getAllSampleIdsInSampleListUsingGET({
                sampleListId: spec.sampleListId
            });
        }));
        for (let i = 0; i < results.length; i++) {
            ret[sampleListsToQuery[i].studyId] = ret[sampleListsToQuery[i].studyId] || {};
            const sampleMap = ret[sampleListsToQuery[i].studyId];
            results[i].map(sampleId => {
                sampleMap[sampleId] = true;
            });
        }
        return ret;
    }, {});

    @computed get studyToSampleListId(): { [studyId: string]: string } {
        return this.samplesSpecification.reduce((map, next) => {
            if (next.sampleListId) {
                map[next.studyId] = next.sampleListId;
            }
            return map;
        }, {} as {[studyId: string]: string});
    }

    readonly studyToMutationMolecularProfile = remoteData<{[studyId: string]: MolecularProfile}>({
        await: () => [
            this.molecularProfilesInStudies
        ],
        invoke: () => {
            const ret: {[studyId: string]: MolecularProfile} = {};
            for (const profile of this.molecularProfilesInStudies.result) {
                const studyId = profile.studyId;
                if (!ret[studyId] && isMutationProfile(profile)) {
                    ret[studyId] = profile;
                }
            }
            return Promise.resolve(ret);
        }
    }, {});

    readonly studyIds = remoteData({
        await: ()=>[this.studyToSampleIds],
        invoke: ()=>{
            return Promise.resolve(Object.keys(this.studyToSampleIds.result));
        }
    });

    @computed get myCancerGenomeData() {
        return fetchMyCancerGenomeData();
    }

    readonly sampleLists = remoteData<SampleList[]>({
        invoke:()=>Promise.all(Object.keys(this.studyToSampleListId).map(studyId=>{
            return client.getSampleListUsingGET({
                sampleListId: this.studyToSampleListId[studyId]
            });
        }))
    });

    readonly mutations = remoteData<Mutation[]>({
        await:()=>[
            this.genes,
            this.selectedMolecularProfiles,
            this.samples,
            this.studyIdToStudy
        ],
        invoke: async ()=>{

            const mutationProfiles = _.filter(this.selectedMolecularProfiles.result,(profile:MolecularProfile)=>profile.molecularAlterationType==='MUTATION_EXTENDED');

            if (mutationProfiles.length === 0) {
                return [];
            }

            const studyIdToProfileMap:{ [studyId:string] : MolecularProfile } = _.keyBy(mutationProfiles,(profile:MolecularProfile)=>profile.studyId);

            const filters = this.samples.result.reduce((memo, sample:Sample)=>{
                if (sample.studyId in studyIdToProfileMap) {
                    memo.push({
                        molecularProfileId: studyIdToProfileMap[sample.studyId].molecularProfileId,
                        sampleId: sample.sampleId
                    });
                }
                return memo;
            }, [] as any[]);

            const data = ({
                entrezGeneIds: _.map(this.genes.result,(gene:Gene)=>gene.entrezGeneId),
                sampleMolecularIdentifiers: filters
            } as MutationMultipleStudyFilter);

            return await client.fetchMutationsInMultipleMolecularProfilesUsingPOST({
                projection:'DETAILED',
                mutationMultipleStudyFilter:data
            });

        }

    });

    @computed get mutationsByGene():{ [hugeGeneSymbol:string]:Mutation[]}{
        return _.groupBy(this.mutations.result,(mutation:Mutation)=>mutation.gene.hugoGeneSymbol);
    }

    readonly mutationMapperStores = remoteData<{ [hugoGeneSymbol: string]: MutationMapperStore }>({
        await: () => [this.genes, this.oncoKbAnnotatedGenes, this.uniqueSampleKeyToTumorType, this.mutations],
        invoke: () => {
            if (this.genes.result) {
                // we have to use _.reduce, otherwise this.genes.result (Immutable, due to remoteData) will return
                //  an Immutable as the result of reduce, and MutationMapperStore when it is made immutable all the
                //  mobx machinery going on in the readonly remoteDatas and observables somehow gets messed up.
                return Promise.resolve(_.reduce(this.genes.result, (map: { [hugoGeneSymbol: string]: MutationMapperStore }, gene: Gene) => {
                    map[gene.hugoGeneSymbol] = new MutationMapperStore(AppConfig,
                        gene,
                        this.samples,
                        this.oncoKbAnnotatedGenes.result || {},
                        this.mutationsByGene[gene.hugoGeneSymbol],
                        () => (this.mutationDataCache),
                        () => (this.genomeNexusEnrichmentCache),
                        () => (this.mutationCountCache),
                        this.studyIdToStudy,
                        this.molecularProfileIdToMolecularProfile,
                        this.clinicalDataForSamples,
                        this.studiesForSamplesWithoutCancerTypeClinicalData,
                        this.samplesWithoutCancerTypeClinicalData,
                        this.germlineConsentedSamples,
                        this.indexedHotspotData,
                        this.uniqueSampleKeyToTumorType.result!,
                        this.oncoKbData
                    );
                    return map;
                }, {}));
            } else {
                return Promise.resolve({});
            }
        }
    }, {});

    public getMutationMapperStore(hugoGeneSymbol: string): MutationMapperStore | undefined {
        return this.mutationMapperStores.result[hugoGeneSymbol];
    }

    readonly oncoKbAnnotatedGenes = remoteData({
        invoke:()=>fetchOncoKbAnnotatedGenes(),
        onError: (err: Error) => {
            // fail silently, leave the error handling responsibility to the data consumer
        }
    }, {});

    readonly clinicalDataForSamples = remoteData<ClinicalData[]>({
        await: () => [
            this.studies,
            this.samples
        ],
        invoke: () => this.getClinicalData("SAMPLE", this.samples.result, ["CANCER_TYPE", "CANCER_TYPE_DETAILED"])
    }, []);

    private getClinicalData(clinicalDataType: "SAMPLE" | "PATIENT", entities: any[], attributeIds: string[]):
    Promise<Array<ClinicalData>> {

        // single study query endpoint is optimal so we should use it
        // when there's only one study
        if (this.studies.result.length === 1) {
            const study = this.studies.result[0];
            const filter: ClinicalDataSingleStudyFilter = {
                attributeIds: attributeIds,
                ids: _.map(entities, clinicalDataType === "SAMPLE" ? 'sampleId' : 'patientId')
            };
            return client.fetchAllClinicalDataInStudyUsingPOST({
                studyId:study.studyId,
                clinicalDataSingleStudyFilter: filter,
                clinicalDataType: clinicalDataType
            });
        } else {
            const filter: ClinicalDataMultiStudyFilter = {
                attributeIds: attributeIds,
                identifiers: entities.map((s: any) => clinicalDataType === "SAMPLE" ?
                    ({entityId: s.sampleId, studyId: s.studyId}) : ({entityId: s.patientId, studyId: s.studyId}))
            };
            return client.fetchClinicalDataUsingPOST({
                clinicalDataType: clinicalDataType,
                clinicalDataMultiStudyFilter: filter
            });
        }
    }

    readonly survivalClinicalData = remoteData<ClinicalData[]>({
        await: () => [
            this.studies,
            this.patients
        ],
        invoke: () => this.getClinicalData("PATIENT", this.patients.result, ["OS_STATUS", "OS_MONTHS", "DFS_STATUS", "DFS_MONTHS"])
    }, []);

    readonly survivalClinicalDataGroupByUniquePatientKey = remoteData<{[key: string]: ClinicalData[]}>({
        await: () => [
            this.survivalClinicalData,
        ],
        invoke: async() => {
            return _.groupBy(this.survivalClinicalData.result, 'uniquePatientKey');
        }
    });

    readonly overallAlteredPatientSurvivals = remoteData<PatientSurvival[]>({
        await: () => [
            this.survivalClinicalDataGroupByUniquePatientKey,
            this.alteredPatientKeys,
            this.patients
        ],
        invoke: async() => {
            return getPatientSurvivals(this.survivalClinicalDataGroupByUniquePatientKey.result,
                this.alteredPatientKeys.result!, 'OS_STATUS', 'OS_MONTHS', s => s === 'DECEASED');
        }
    }, []);

    readonly overallUnalteredPatientSurvivals = remoteData<PatientSurvival[]>({
        await: () => [
            this.survivalClinicalDataGroupByUniquePatientKey,
            this.unalteredPatientKeys,
            this.patients
        ],
        invoke: async() => {
            return getPatientSurvivals(this.survivalClinicalDataGroupByUniquePatientKey.result,
                this.unalteredPatientKeys.result!, 'OS_STATUS', 'OS_MONTHS', s => s === 'DECEASED');
        }
    }, []);

    readonly diseaseFreeAlteredPatientSurvivals = remoteData<PatientSurvival[]>({
        await: () => [
            this.survivalClinicalDataGroupByUniquePatientKey,
            this.alteredPatientKeys,
            this.patients
        ],
        invoke: async() => {
            return getPatientSurvivals(this.survivalClinicalDataGroupByUniquePatientKey.result,
                this.alteredPatientKeys.result!, 'DFS_STATUS', 'DFS_MONTHS', s => s === 'Recurred/Progressed' || s === 'Recurred');
        }
    }, []);

    readonly diseaseFreeUnalteredPatientSurvivals = remoteData<PatientSurvival[]>({
        await: () => [
            this.survivalClinicalDataGroupByUniquePatientKey,
            this.unalteredPatientKeys,
            this.patients
        ],
        invoke: async() => {
            return getPatientSurvivals(this.survivalClinicalDataGroupByUniquePatientKey.result,
                this.unalteredPatientKeys.result!, 'DFS_STATUS', 'DFS_MONTHS', s => s === 'Recurred/Progressed' || s === 'Recurred');
        }
    }, []);

    readonly germlineConsentedSamples = remoteData<SampleIdentifier[]>({
        await:()=>[this.studyIds],
        invoke: async() => await fetchGermlineConsentedSamples(this.studyIds, AppConfig.studiesWithGermlineConsentedSamples),
        onError: () => {
            // fail silently
        }
    }, []);

    readonly samples = remoteData({
        await: () => [
            this.studyToDataQueryFilter
        ],
        invoke: async() => {

            let sampleIdentifiers: SampleIdentifier[] = [];
            let sampleListIds: string[] = [];
            _.each(this.studyToDataQueryFilter.result, (dataQueryFilter: IDataQueryFilter, studyId: string) => {
                if (dataQueryFilter.sampleIds) {
                    sampleIdentifiers = sampleIdentifiers.concat(dataQueryFilter.sampleIds.map(sampleId => ({
                        sampleId,
                        studyId
                    })));
                } else if (dataQueryFilter.sampleListId) {
                    sampleListIds.push(dataQueryFilter.sampleListId);
                }
            });
            let promises:Promise<Sample[]>[] = [];
            if (sampleIdentifiers.length) {
                promises.push(client.fetchSamplesUsingPOST({
                    sampleFilter: {
                        sampleIdentifiers
                    } as SampleFilter
                }));
            }
            if (sampleListIds.length) {
                promises.push(client.fetchSamplesUsingPOST({
                    sampleFilter: {
                        sampleListIds
                    } as SampleFilter
                }));
            }
            return _.flatten(await Promise.all(promises));
        }
    }, []);

    readonly sampleKeyToSample = remoteData({
        await: ()=>[
            this.samples
        ],
        invoke: ()=>{
            return Promise.resolve(_.keyBy(this.samples.result!, sample=>sample.uniqueSampleKey));
        }
    });

    readonly patientKeyToPatient = remoteData({
        await: ()=>[
            this.patients
        ],
        invoke: ()=>{
            return Promise.resolve(_.keyBy(this.patients.result!, patient=>patient.uniquePatientKey));
        }
    });

    readonly patients = remoteData({
        await: ()=>[
            this.samples
        ],
        invoke: ()=>{
            let patientKeyToPatientIdentifier:{[uniquePatientKey:string]:PatientIdentifier} = {};
            for (const sample of this.samples.result) {
                patientKeyToPatientIdentifier[sample.uniquePatientKey] = {
                    patientId: sample.patientId,
                    studyId: sample.studyId
                };
            }
            const patientFilter = {
                uniquePatientKeys: _.uniq(this.samples.result.map((sample:Sample)=>sample.uniquePatientKey))
            } as PatientFilter;

            return client.fetchPatientsUsingPOST({
                patientFilter
            });
        },
        default: []
    });

    readonly samplesWithoutCancerTypeClinicalData = remoteData<Sample[]>({
        await: () => [
            this.samples,
            this.clinicalDataForSamples
        ],
        invoke: () => {
            const sampleHasData: { [sampleUid: string]: boolean } = {};
            for (const data of this.clinicalDataForSamples.result) {
                sampleHasData[toSampleUuid(data.studyId, data.sampleId)] = true;
            }
            return Promise.resolve(this.samples.result.filter(sample => {
                return !sampleHasData[toSampleUuid(sample.studyId, sample.sampleId)];
            }));
        }
    }, []);

    readonly studiesForSamplesWithoutCancerTypeClinicalData = remoteData({
        await: () => [
            this.samplesWithoutCancerTypeClinicalData
        ],
        invoke: async () => fetchStudiesForSamplesWithoutCancerTypeClinicalData(this.samplesWithoutCancerTypeClinicalData)
    }, []);

    readonly studies = remoteData({
        await: ()=>[this.studyIds],
        invoke: async () => {
            return client.fetchStudiesUsingPOST({
                studyIds:this.studyIds.result!,
                projection:'DETAILED'
            })
        }
    }, []);
    
    //user saved virtual studies
    private readonly virtualStudies = remoteData(sessionServiceClient.getUserVirtualStudies(), []);
    
    private readonly virtualStudyIdToStudy = remoteData({
        await: ()=>[this.virtualStudies],
        invoke: async ()=>{
            return _.keyBy(
                this.virtualStudies.result.map(virtualStudy=>{
                    let study = {
                        allSampleCount:_.sumBy(virtualStudy.data.studies, study=>study.samples.length),
                        studyId: virtualStudy.id,
                        name: virtualStudy.data.name,
                        description: virtualStudy.data.description,
                        cancerTypeId: "My Virtual Studies"
                    } as CancerStudy;
                    return study;
                }), x =>x.studyId);
        }
    },{});

    //this is only required to show study name and description on the results page
    readonly queriedStudies = remoteData({
		await: ()=>[this.studyIdToStudy, this.virtualStudyIdToStudy],
		invoke: async ()=>{
            return getQueriedStudies(this.studyIdToStudy.result,
                                     this.virtualStudyIdToStudy.result,
                                     this.cohortIdsList);
		},
		default: [],
    });

    readonly studyIdToStudy = remoteData({
        await: ()=>[this.studies],
        invoke:()=>Promise.resolve(_.keyBy(this.studies.result, x=>x.studyId))
    }, {});

    readonly molecularProfilesInStudies = remoteData<MolecularProfile[]>({
        await:()=>[this.studyIds],
        invoke: async () => {
            return client.fetchMolecularProfilesUsingPOST({
                molecularProfileFilter: { studyIds:this.studyIds.result! } as MolecularProfileFilter
            })
        }
    }, []);

    readonly molecularProfileIdToMolecularProfile = remoteData<{ [molecularProfileId: string]: MolecularProfile }>({
        await: () => [this.molecularProfilesInStudies],
        invoke: () => {
            return Promise.resolve(this.molecularProfilesInStudies.result.reduce((map: { [molecularProfileId: string]: MolecularProfile }, next: MolecularProfile) => {
                map[next.molecularProfileId] = next;
                return map;
            }, {}));
        }
    }, {});

    readonly studyToMolecularProfileDiscrete = remoteData<{ [studyId: string]: MolecularProfile }>({
        await: () => [
            this.molecularProfilesInStudies
        ],
        invoke: async () => {
            const ret: { [studyId: string]: MolecularProfile } = {};
            for (const molecularProfile of this.molecularProfilesInStudies.result) {
                if (molecularProfile.datatype === "DISCRETE") {
                    ret[molecularProfile.studyId] = molecularProfile;
                }
            }
            return ret;
        }
    }, {});

    readonly heatmapMolecularProfiles = remoteData<MolecularProfile[]>({
        await: () => [
            this.molecularProfilesInStudies,
            this.genesetMolecularProfile
        ],
        invoke: () => {
            const MRNA_EXPRESSION = AlterationTypeConstants.MRNA_EXPRESSION;
            const PROTEIN_LEVEL = AlterationTypeConstants.PROTEIN_LEVEL;
            const METHYLATION = AlterationTypeConstants.METHYLATION;
            const selectedMolecularProfileIds = stringListToSet(this.selectedMolecularProfileIds);

            const expressionHeatmaps = _.sortBy(
                _.filter(this.molecularProfilesInStudies.result!, profile=>{
                    return ((profile.molecularAlterationType === MRNA_EXPRESSION ||
                        profile.molecularAlterationType === PROTEIN_LEVEL) && profile.showProfileInAnalysisTab) ||
                        profile.molecularAlterationType === METHYLATION;
                    }
                ),
                profile=>{
                    // Sort order: selected and [mrna, protein, methylation], unselected and [mrna, protein, meth]
                    if (profile.molecularProfileId in selectedMolecularProfileIds) {
                        switch (profile.molecularAlterationType) {
                            case MRNA_EXPRESSION:
                                return 0;
                            case PROTEIN_LEVEL:
                                return 1;
                            case METHYLATION:
                                return 2;
                        }
                    } else {
                        switch(profile.molecularAlterationType) {
                            case MRNA_EXPRESSION:
                                return 3;
                            case PROTEIN_LEVEL:
                                return 4;
                            case METHYLATION:
                                return 5;
                        }
                    }
                }
            );
            const genesetMolecularProfile = this.genesetMolecularProfile.result!;
            const genesetHeatmaps = (
                genesetMolecularProfile.isApplicable
                ? [genesetMolecularProfile.value]
                : []
            );
            return Promise.resolve(expressionHeatmaps.concat(genesetHeatmaps));
        }
    });

    readonly genesetMolecularProfile = remoteData<Optional<MolecularProfile>>({
        await: () => [
            this.selectedMolecularProfiles
        ],
        invoke: () => {
            const applicableProfiles = _.filter(
                this.selectedMolecularProfiles.result!,
                profile => (
                    profile.molecularAlterationType === AlterationTypeConstants.GENESET_SCORE
                    && profile.showProfileInAnalysisTab
                )
            );
            if (applicableProfiles.length > 1) {
                return Promise.reject(new Error("Queried more than one gene set score profile"));
            }
            const genesetProfile = applicableProfiles.pop();
            const value: Optional<MolecularProfile> = (
                genesetProfile
                ? {isApplicable: true, value: genesetProfile}
                : {isApplicable: false}
            );
            return Promise.resolve(value);
        }
    });

    readonly studyToDataQueryFilter = remoteData<{ [studyId: string]: IDataQueryFilter }>({
        await: () => [this.studyToSampleIds, this.studyIds],
        invoke: () => {
            const studies = this.studyIds.result!;
            const ret: { [studyId: string]: IDataQueryFilter } = {};
            for (const studyId of studies) {
                ret[studyId] = generateDataQueryFilter(this.studyToSampleListId[studyId] || null, Object.keys(this.studyToSampleIds.result[studyId] || {}))
            }
            return Promise.resolve(ret);
        }
    }, {});

    readonly molecularProfileIdToDataQueryFilter = remoteData<{[molecularProfileId:string]:IDataQueryFilter}>({
        await: ()=>[
            this.molecularProfilesInStudies,
            this.studyToDataQueryFilter
        ],
        invoke: ()=>{
            const ret:{[molecularProfileId:string]:IDataQueryFilter} = {};
            for (const molecularProfile of this.molecularProfilesInStudies.result!) {
                ret[molecularProfile.molecularProfileId] = this.studyToDataQueryFilter.result![molecularProfile.studyId];
            }
            return Promise.resolve(ret);
        },
        default: {}
    });

    readonly genes = remoteData<Gene[]>({
        invoke: async () => {
            if (this.hugoGeneSymbols && this.hugoGeneSymbols.length) {
                const order = stringListToIndexSet(this.hugoGeneSymbols);
                return _.sortBy(await client.fetchGenesUsingPOST({
                    geneIdType: "HUGO_GENE_SYMBOL",
                    geneIds: this.hugoGeneSymbols.slice(),
                    projection: "SUMMARY"
                }), (gene: Gene) => order[gene.hugoGeneSymbol]);
            } else {
                return [];
            }
        },
        onResult:(genes:Gene[])=>{
            this.geneCache.addData(genes);
        }
    });

    readonly genesetLinkMap = remoteData<{[genesetId: string]: string}>({
        invoke: async () => {
            if (this.genesetIds && this.genesetIds.length) {
                const genesets = await internalClient.fetchGenesetsUsingPOST(
                    {genesetIds: this.genesetIds.slice()}
                );
                const linkMap: {[genesetId: string]: string} = {};
                genesets.forEach(({genesetId, refLink}) => {
                    linkMap[genesetId] = refLink;
                });
                return linkMap;
            } else {
                return {};
            }
        }
    });

    readonly customDriverAnnotationReport = remoteData<{ hasBinary:boolean, tiers:string[] }>({
        await:()=>[
            this.mutations
        ],
        invoke:()=>{
            return Promise.resolve(computeCustomDriverAnnotationReport(this.mutations.result!));
        },
        onResult:result=>{
            initializeCustomDriverAnnotationSettings(
                result!,
                this.mutationAnnotationSettings,
                !!AppConfig.oncoprintCustomDriverTiersAnnotationDefault,
                AppConfig.oncoprintOncoKbHotspotsDefault === "custom"
            );
        }
    });

    readonly putativeDriverAnnotatedMutations = remoteData<AnnotatedMutation[]>({
        await:()=>[
            this.mutations,
            this.getPutativeDriverInfo
        ],
        invoke:()=>{
            return Promise.resolve(computePutativeDriverAnnotatedMutations(this.mutations.result!, this.getPutativeDriverInfo.result!, !!this.mutationAnnotationSettings.ignoreUnknown));
        }
    });

    readonly annotatedMolecularData = remoteData<AnnotatedNumericGeneMolecularData[]>({
        await: ()=>[
            this.molecularData,
            this.getOncoKbCnaAnnotationForOncoprint,
            this.molecularProfileIdToMolecularProfile
        ],
        invoke:()=>{
            let getOncoKbAnnotation:(datum:NumericGeneMolecularData)=>IndicatorQueryResp|undefined;
            if (this.getOncoKbCnaAnnotationForOncoprint.result! instanceof Error) {
                getOncoKbAnnotation = ()=>undefined;
            } else {
                getOncoKbAnnotation = this.getOncoKbCnaAnnotationForOncoprint.result! as typeof getOncoKbAnnotation;
            }
            const profileIdToProfile = this.molecularProfileIdToMolecularProfile.result!;
            return Promise.resolve(this.molecularData.result!.map(d=>{
                    return annotateMolecularDatum(
                        d,
                        getOncoKbAnnotation,
                        profileIdToProfile
                    );
                })
            );
        }
    });

    readonly getPutativeDriverInfo = remoteData({
        await:()=>{
            const toAwait = [];
            if (this.mutationAnnotationSettings.oncoKb) {
                toAwait.push(this.getOncoKbMutationAnnotationForOncoprint);
            }
            if (this.mutationAnnotationSettings.hotspots) {
                toAwait.push(this.indexedHotspotData);
            }
            if (this.mutationAnnotationSettings.cbioportalCount) {
                toAwait.push(this.getCBioportalCount);
            }
            if (this.mutationAnnotationSettings.cosmicCount) {
                toAwait.push(this.getCosmicCount);
            }
            return toAwait;
        },
        invoke:()=>{
            return Promise.resolve((mutation:Mutation):{oncoKb:string, hotspots:boolean, cbioportalCount:boolean, cosmicCount:boolean, customDriverBinary:boolean, customDriverTier?:string}=>{
                const getOncoKbMutationAnnotationForOncoprint = this.getOncoKbMutationAnnotationForOncoprint.result!;
                const oncoKbDatum:IndicatorQueryResp | undefined | null | false = this.mutationAnnotationSettings.oncoKb &&
                    (!(getOncoKbMutationAnnotationForOncoprint instanceof Error)) &&
                    getOncoKbMutationAnnotationForOncoprint(mutation);

                let oncoKb:string = "";
                if (oncoKbDatum) {
                    oncoKb = getOncoKbOncogenic(oncoKbDatum);
                }

                const hotspots:boolean =
                    (this.mutationAnnotationSettings.hotspots &&
                    this.indexedHotspotData.isComplete &&
                    isRecurrentHotspot(mutation, this.indexedHotspotData.result!));

                const cbioportalCount:boolean =
                    (this.mutationAnnotationSettings.cbioportalCount &&
                    this.getCBioportalCount.isComplete &&
                    this.getCBioportalCount.result!(mutation) >=
                    this.mutationAnnotationSettings.cbioportalCountThreshold);

                const cosmicCount:boolean =
                    (this.mutationAnnotationSettings.cosmicCount &&
                    this.getCosmicCount.isComplete &&
                    this.getCosmicCount.result!(mutation) >= this.mutationAnnotationSettings.cosmicCountThreshold);

                const customDriverBinary:boolean =
                    (this.mutationAnnotationSettings.driverFilter &&
                        mutation.driverFilter === "Putative_Driver") || false;

                const customDriverTier:string|undefined =
                    (mutation.driverTiersFilter && this.mutationAnnotationSettings.driverTiers.get(mutation.driverTiersFilter)) ?
                    mutation.driverTiersFilter : undefined;

                return {
                    oncoKb,
                    hotspots,
                    cbioportalCount,
                    cosmicCount,
                    customDriverBinary,
                    customDriverTier
                }
            });
        }
    });

    // Mutation annotation
    // Hotspots
    readonly hotspotData = remoteData({
        await:()=>[
            this.mutations
        ],
        invoke:()=>{
            return fetchHotspotsData(this.mutations);
        }
    });

    readonly indexedHotspotData = remoteData<IHotspotIndex|undefined>({
        await:()=>[
            this.hotspotData
        ],
        invoke: ()=>Promise.resolve(indexHotspotsData(this.hotspotData))
    });

    //OncoKb
    readonly uniqueSampleKeyToTumorType = remoteData<{[uniqueSampleKey: string]: string}>({
        await:()=>[
            this.clinicalDataForSamples,
            this.studiesForSamplesWithoutCancerTypeClinicalData,
            this.samplesWithoutCancerTypeClinicalData
        ],
        invoke: ()=>{
            return Promise.resolve(generateUniqueSampleKeyToTumorTypeMap(this.clinicalDataForSamples,
                this.studiesForSamplesWithoutCancerTypeClinicalData,
                this.samplesWithoutCancerTypeClinicalData));
        }
    });

    readonly oncoKbData = remoteData<IOncoKbData>({
        await: () => [
            this.mutations,
            this.clinicalDataForSamples,
            this.studiesForSamplesWithoutCancerTypeClinicalData,
            this.uniqueSampleKeyToTumorType,
            this.oncoKbAnnotatedGenes
        ],
        invoke: () => fetchOncoKbData(this.uniqueSampleKeyToTumorType.result!, this.oncoKbAnnotatedGenes.result!, this.mutations),
        onError: (err: Error) => {
            // fail silently, leave the error handling responsibility to the data consumer
        }
    }, ONCOKB_DEFAULT);

    //we need seperate oncokb data because oncoprint requires onkb queries across cancertype
    //mutations tab the opposite
    readonly oncoKbDataForOncoprint = remoteData<IOncoKbData|Error>({
        await: () => [
            this.mutations,
            this.uniqueSampleKeyToTumorType,
            this.oncoKbAnnotatedGenes
        ],
        invoke: async() => {
            let result;
            try {
                result = await fetchOncoKbData({}, this.oncoKbAnnotatedGenes.result!, this.mutations)
            } catch(e) {
                result = new Error();
            }
            return result;
        },
        onError: (err: Error) => {
            // fail silently, leave the error handling responsibility to the data consumer
        }
    }, ONCOKB_DEFAULT);

    readonly cnaOncoKbData = remoteData<IOncoKbData>({
        await: ()=> [
            this.uniqueSampleKeyToTumorType,
            this.oncoKbAnnotatedGenes,
            this.molecularData,
            this.molecularProfileIdToMolecularProfile
        ],
        invoke: () => fetchCnaOncoKbDataWithNumericGeneMolecularData(
            this.uniqueSampleKeyToTumorType.result!,
            this.oncoKbAnnotatedGenes.result!,
            this.molecularData,
            this.molecularProfileIdToMolecularProfile.result!
        )
    }, ONCOKB_DEFAULT);

    //we need seperate oncokb data because oncoprint requires onkb queries across cancertype
    //mutations tab the opposite
    readonly cnaOncoKbDataForOncoprint = remoteData<IOncoKbData|Error>({
        await: ()=> [
            this.uniqueSampleKeyToTumorType,
            this.oncoKbAnnotatedGenes,
            this.molecularData,
            this.molecularProfileIdToMolecularProfile
        ],
        invoke: async() => {
            let result;
            try {
                result = await fetchCnaOncoKbDataWithNumericGeneMolecularData(
                    {},
                    this.oncoKbAnnotatedGenes.result!,
                    this.molecularData,
                    this.molecularProfileIdToMolecularProfile.result!
                );
            } catch(e) {
                result = new Error();
            }
            return result;
        }
    }, ONCOKB_DEFAULT);

    @computed get didOncoKbFailInOncoprint() {
        return this.getOncoKbMutationAnnotationForOncoprint.result instanceof Error;
    }

    readonly getOncoKbMutationAnnotationForOncoprint = remoteData<Error|((mutation:Mutation)=>(IndicatorQueryResp|undefined))>({
        await: ()=>[
            this.oncoKbDataForOncoprint
        ],
        invoke: ()=>{
            const oncoKbDataForOncoprint = this.oncoKbDataForOncoprint.result!;
            if (oncoKbDataForOncoprint instanceof Error) {
                return Promise.resolve(new Error());
            } else {
                return Promise.resolve((mutation:Mutation)=>{
                    const uniqueSampleKeyToTumorType = oncoKbDataForOncoprint.uniqueSampleKeyToTumorType!;
                    const id = generateQueryVariantId(
                        mutation.entrezGeneId,
                        cancerTypeForOncoKb(mutation.uniqueSampleKey, uniqueSampleKeyToTumorType),
                        mutation.proteinChange,
                        mutation.mutationType
                    );
                    return oncoKbDataForOncoprint.indicatorMap![id];
                });
            }
        }
    });

    readonly getOncoKbCnaAnnotationForOncoprint = remoteData<Error|((data:NumericGeneMolecularData)=>(IndicatorQueryResp|undefined))>({
        await: ()=>[
            this.cnaOncoKbDataForOncoprint
        ],
        invoke: ()=>{
            const cnaOncoKbDataForOncoprint = this.cnaOncoKbDataForOncoprint.result!;
            if (cnaOncoKbDataForOncoprint instanceof Error) {
                return Promise.resolve(new Error());
            } else {
                return Promise.resolve((data:NumericGeneMolecularData)=>{
                    const uniqueSampleKeyToTumorType = cnaOncoKbDataForOncoprint.uniqueSampleKeyToTumorType!;
                    const id = generateQueryVariantId(
                        data.entrezGeneId,
                        cancerTypeForOncoKb(data.uniqueSampleKey, uniqueSampleKeyToTumorType),
                        getAlterationString(data.value)
                    );
                    return cnaOncoKbDataForOncoprint.indicatorMap![id];
                });
            }
        }
    });

    readonly cbioportalMutationCountData = remoteData<MutationCountByPosition[]>({
        await: ()=>[
            this.mutations
        ],
        invoke: ()=>{

            const mutationPositionIdentifiers = countMutations(this.mutations.result!);

            return client.fetchMutationCountsByPositionUsingPOST({
                mutationPositionIdentifiers: _.values(mutationPositionIdentifiers)
            });
        }
    });

    readonly getCBioportalCount:MobxPromise<(mutation:Mutation)=>number> = remoteData({
        await: ()=>[
            this.cbioportalMutationCountData
        ],
        invoke: ()=>{
            const countsMap = _.groupBy(this.cbioportalMutationCountData.result!, count=>mutationCountByPositionKey(count));
            return Promise.resolve((mutation:Mutation):number=>{
                const key = mutationCountByPositionKey(mutation);
                const counts = countsMap[key];
                if (counts) {
                    return counts.reduce((count, next)=>{
                        return count + next.count;
                    }, 0);
                } else {
                    return -1;
                }
            });
        }
    });
    //COSMIC count
    readonly cosmicCountData = remoteData<CosmicMutation[]>({
        await: ()=>[
            this.mutations
        ],
        invoke: ()=>{
            return internalClient.fetchCosmicCountsUsingPOST({
                keywords: _.uniq(this.mutations.result!.filter((m:Mutation)=>{
                    // keyword is what we use to query COSMIC count with, so we need
                    //  the unique list of mutation keywords to query. If a mutation has
                    //  no keyword, it cannot be queried for.
                    return !!m.keyword;
                }).map((m:Mutation)=>m.keyword))
            });
        }
    });

    readonly getCosmicCount:MobxPromise<(mutation:Mutation)=>number> = remoteData({
        await: ()=>[
            this.cosmicCountData
        ],
        invoke: ()=>{
            const countMap = _.groupBy(this.cosmicCountData.result!, d=>d.keyword);
            return Promise.resolve((mutation:Mutation):number=>{
                const keyword = mutation.keyword;
                const counts = countMap[keyword];
                if (counts) {
                    return counts.reduce((count, next:CosmicMutation)=>{
                        return count + next.count;
                    }, 0);
                } else {
                    return -1;
                }
            });
        }
    });

    @cached get oncoKbEvidenceCache() {
        return new OncoKbEvidenceCache();
    }

    @cached get pubMedCache() {
        return new PubMedCache();
    }

    @cached get discreteCNACache() {
        return new DiscreteCNACache(this.studyToMolecularProfileDiscrete.result);
    }

    @cached get genomeNexusEnrichmentCache() {
        return new GenomeNexusEnrichmentCache();
    }

    @cached get cancerTypeCache() {
        return new CancerTypeCache();
    }

    @cached get mutationCountCache() {
        return new MutationCountCache();
    }

    @cached get pdbHeaderCache() {
        return new PdbHeaderCache();
    }

    @cached get mutationDataCache() {
        return new MutationDataCache(this.studyToMutationMolecularProfile.result,
            this.studyToDataQueryFilter.result);
    }

    readonly geneMolecularDataCache = remoteData({
        await:()=>[
            this.molecularProfileIdToDataQueryFilter
        ],
        invoke: ()=>{
            return Promise.resolve(
                new GeneMolecularDataCache(
                    this.molecularProfileIdToDataQueryFilter.result
                )
            );
        }
    });

    readonly genesetMolecularDataCache = remoteData({
        await:() => [
            this.molecularProfileIdToDataQueryFilter
        ],
        invoke: () => Promise.resolve(
            new GenesetMolecularDataCache(
                this.molecularProfileIdToDataQueryFilter.result!
            )
        )
    });

    readonly genesetCorrelatedGeneCache = remoteData({
        await:() => [
            this.molecularProfileIdToDataQueryFilter
        ],
        invoke: () => Promise.resolve(
            new GenesetCorrelatedGeneCache(
                this.molecularProfileIdToDataQueryFilter.result!
            )
        )
    });

    @cached get geneCache() {
        return new GeneCache();
    }

    @cached get clinicalDataCache() {
        return new ClinicalDataCache(this.samples.result, this.patients.result, this.studyToMutationMolecularProfile.result, this.studyIdToStudy.result);
    }

    @action clearErrors() {
        this.ajaxErrors = [];
    }
}

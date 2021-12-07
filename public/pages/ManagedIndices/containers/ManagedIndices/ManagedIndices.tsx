/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Component } from "react";
import { RouteComponentProps } from "react-router-dom";
import {
  EuiHorizontalRule,
  EuiLink,
  EuiFlexGroup,
  EuiFlexItem,
  EuiButton,
  EuiTitle,
  EuiSpacer,
  EuiTableFieldDataColumnType,
  EuiTableSortingType,
  Direction,
  // @ts-ignore
  Pagination,
  EuiTableSelectionType,
  Query,
  EuiInMemoryTable,
} from "@elastic/eui";
import queryString from "query-string";
import _ from "lodash";
import { ContentPanel, ContentPanelActions } from "../../../../components/ContentPanel";
import ManagedIndexControls from "../../components/ManagedIndexControls";
import ManagedIndexEmptyPrompt from "../../components/ManagedIndexEmptyPrompt";
import { DEFAULT_PAGE_SIZE_OPTIONS, DEFAULT_QUERY_PARAMS, SEARCH_SCHEMA } from "../../utils/constants";
import { BREADCRUMBS, DEFAULT_EMPTY_DATA, PLUGIN_NAME, ROUTES } from "../../../../utils/constants";
import InfoModal from "../../components/InfoModal";
import PolicyModal from "../../../../components/PolicyModal";
import { ModalConsumer } from "../../../../components/Modal";
import { getURLQueryParams } from "../../utils/helpers";
import { ManagedIndexItem } from "../../../../../models/interfaces";
import { ManagedIndexService } from "../../../../services";
import { getErrorMessage } from "../../../../utils/helpers";
import ConfirmationModal from "../../../../components/ConfirmationModal";
import RetryModal from "../../components/RetryModal";
import RolloverAliasModal from "../../components/RolloverAliasModal";
import { CoreServicesContext } from "../../../../components/core_services";
import { DataStream } from "../../../../../server/models/interfaces";
import {
  CUSTOM_DATA_STREAM_SECURITY_EXCEPTION,
  DATA_STREAM_LACK_PERMISSION_WARNING,
} from "../../../../../server/services/DataStreamService";

interface ManagedIndicesProps extends RouteComponentProps {
  managedIndexService: ManagedIndexService;
}

interface ManagedIndicesState {
  totalManagedIndices: number;
  search: string;
  query: Query | null;
  sortField: keyof ManagedIndexItem;
  sortDirection: Direction;
  selectedItems: ManagedIndexItem[];
  managedIndices: ManagedIndexItem[];
  loadingManagedIndices: boolean;
  showDataStreams: boolean;
  isDataStreamColumnVisible: boolean;
}

export default class ManagedIndices extends Component<ManagedIndicesProps, ManagedIndicesState> {
  static contextType = CoreServicesContext;
  columns: EuiTableFieldDataColumnType<ManagedIndexItem>[];

  constructor(props: ManagedIndicesProps) {
    super(props);

    const { search, sortField, sortDirection, showDataStreams } = getURLQueryParams(this.props.location);

    this.state = {
      totalManagedIndices: 0,
      search,
      query: Query.parse(search),
      sortField,
      sortDirection,
      selectedItems: [],
      managedIndices: [],
      loadingManagedIndices: true,
      showDataStreams,
      isDataStreamColumnVisible: showDataStreams,
    };

    this.getManagedIndices = _.debounce(this.getManagedIndices, 500, { leading: true });

    this.columns = [
      {
        field: "index",
        name: "Index",
        sortable: true,
        truncateText: true,
        textOnly: true,
        width: "150px",
        render: (index: string) => <span title={index}>{index}</span>,
      },
      {
        field: "dataStream",
        name: "Data stream",
        sortable: true,
        truncateText: true,
        textOnly: true,
        width: "120px",
        render: (dataStream) => dataStream || DEFAULT_EMPTY_DATA,
      },
      {
        field: "policyId",
        name: "Policy",
        sortable: true,
        truncateText: true,
        textOnly: true,
        width: "140px",
        render: this.renderPolicyId,
      },
      {
        field: "managedIndexMetaData.state.name",
        name: "State",
        sortable: false,
        truncateText: false,
        width: "150px",
        // @ts-ignore
        render: (state: string) => state || DEFAULT_EMPTY_DATA,
      },
      {
        field: "managedIndexMetaData.action.name",
        name: "Action",
        sortable: false,
        truncateText: false,
        width: "150px",
        // @ts-ignore
        render: (action: string) => (
          <span style={{ textTransform: "capitalize" }}>{(action || DEFAULT_EMPTY_DATA).split("_").join(" ")}</span>
        ),
      },
      {
        field: "managedIndexMetaData.info",
        name: "Info",
        sortable: false,
        truncateText: true,
        textOnly: true,
        width: "150px",
        render: (info: object) => (
          <ModalConsumer>
            {({ onShow }) => <EuiLink onClick={() => onShow(InfoModal, { info })}>{_.get(info, "message", DEFAULT_EMPTY_DATA)}</EuiLink>}
          </ModalConsumer>
        ),
      },
      {
        field: "index", // we don't care about the field as we're using the whole item in render
        name: "Job Status",
        sortable: false,
        truncateText: false,
        width: "150px",
        render: (index: string, item: ManagedIndexItem) => {
          const { managedIndexMetaData } = item;
          if (!managedIndexMetaData) return "Initializing";
          const { policyCompleted, retryInfo, action } = managedIndexMetaData;
          if (policyCompleted) return "Completed";
          if (retryInfo && retryInfo.failed) return "Failed";
          if (action && action.failed) return "Failed";
          return "Running";
        },
      },
    ];
  }

  managedIndicesColumns = (isDataStreamColumnVisible: boolean): EuiTableFieldDataColumnType<ManagedIndexItem>[] => {
    return isDataStreamColumnVisible ? this.columns : this.columns.filter((col) => col["field"] !== "dataStream");
  };

  async componentDidMount() {
    this.context.chrome.setBreadcrumbs([BREADCRUMBS.INDEX_MANAGEMENT, BREADCRUMBS.MANAGED_INDICES]);
    await this.getManagedIndices();
  }

  async componentDidUpdate(prevProps: ManagedIndicesProps, prevState: ManagedIndicesState) {
    const prevQuery = ManagedIndices.getQueryObjectFromState(prevState);
    const currQuery = ManagedIndices.getQueryObjectFromState(this.state);
    if (!_.isEqual(prevQuery, currQuery)) {
      await this.getManagedIndices();
    }
  }

  static getQueryObjectFromState({ search, sortField, sortDirection, showDataStreams }: ManagedIndicesState) {
    return {
      from: 0,
      size: 10000,
      search,
      sortField,
      sortDirection,
      showDataStreams,
    };
  }

  renderPolicyId = (policyId: string, item: ManagedIndexItem) => {
    let errorMessage: string | undefined = undefined;
    if (item.managedIndexMetaData?.policySeqNo == null) errorMessage = `Still initializing, please wait a moment`;
    if (!item.policy) errorMessage = `Failed to load the policy: ${item.policyId}`;

    return (
      <ModalConsumer>
        {({ onShow, onClose }) => (
          <EuiLink
            onClick={() =>
              onShow(PolicyModal, {
                policyId: policyId,
                policy: item.policy,
                onEdit: () => this.onClickModalEdit(item, onClose),
                errorMessage,
              })
            }
          >
            {policyId}
          </EuiLink>
        )}
      </ModalConsumer>
    );
  };

  getManagedIndices = async (): Promise<void> => {
    this.setState({ loadingManagedIndices: true });
    try {
      const { managedIndexService, history } = this.props;
      const queryObject = ManagedIndices.getQueryObjectFromState(this.state);
      const queryParamsString = queryString.stringify(queryObject);
      history.replace({ ...this.props.location, search: queryParamsString });

      const getManagedIndicesResponse = await managedIndexService.getManagedIndices({
        ...queryObject,
        terms: this.getTermClausesFromState(),
        indices: this.getFieldClausesFromState("indices"),
        dataStreams: this.getFieldClausesFromState("data_streams"),
      });

      if (getManagedIndicesResponse.ok) {
        const {
          response: { managedIndices, totalManagedIndices },
        } = getManagedIndicesResponse;
        this.setState({ managedIndices, totalManagedIndices });
      } else {
        this.context.notifications.toasts.addDanger(getManagedIndicesResponse.error);
      }
    } catch (err) {
      this.context.notifications.toasts.addDanger(getErrorMessage(err, "There was a problem loading the managed indices"));
    }

    // Avoiding flicker by showing/hiding the "Data stream" column only after the results are loaded.
    const { showDataStreams } = this.state;
    this.setState({ loadingManagedIndices: false, isDataStreamColumnVisible: showDataStreams });
  };

  getDataStreams = async (): Promise<DataStream[]> => {
    const { managedIndexService } = this.props;
    const serverResponse = await managedIndexService.getDataStreams();
    if (!serverResponse.ok) {
      if (serverResponse.error.startsWith(CUSTOM_DATA_STREAM_SECURITY_EXCEPTION)) {
        this.context.notifications.toasts.addWarning(DATA_STREAM_LACK_PERMISSION_WARNING);
      }
    }
    return serverResponse.response.dataStreams;
  };

  toggleShowDataStreams = (): void => {
    const { showDataStreams } = this.state;
    this.setState({ showDataStreams: !showDataStreams });
  };

  getFieldClausesFromState = (clause: string): string[] => {
    const { query } = this.state;
    return _.flatten((query.ast.getFieldClauses(clause) || []).map((field) => field.value));
  };

  getTermClausesFromState = (): string[] => {
    const { query } = this.state;
    return (query.ast.getTermClauses() || []).map((term) => term.value);
  };

  onClickRemovePolicy = async (indices: string[]): Promise<void> => {
    try {
      if (!indices.length) return;
      const { managedIndexService } = this.props;
      const removePolicyResponse = await managedIndexService.removePolicy(indices);
      if (removePolicyResponse.ok) {
        const { updatedIndices, failedIndices, failures } = removePolicyResponse.response;
        if (updatedIndices) {
          this.context.notifications.toasts.addSuccess(`Removed policy from ${updatedIndices} managed indices`);
        }
        if (failures) {
          this.context.notifications.toasts.addDanger(
            `Failed to remove policy from ${failedIndices
              .map((failedIndex) => `[${failedIndex.indexName}, ${failedIndex.reason}]`)
              .join(", ")}`
          );
        }
      } else {
        this.context.notifications.toasts.addDanger(removePolicyResponse.error);
      }
    } catch (err) {
      this.context.notifications.toasts.addDanger(getErrorMessage(err, "There was a problem removing the policies"));
    }
  };

  onSelectionChange = (selectedItems: ManagedIndexItem[]): void => {
    this.setState({ selectedItems });
  };

  onClickModalEdit = (item: ManagedIndexItem, onClose: () => void): void => {
    onClose();
    if (!item || !item.policyId) return;
    this.props.history.push(`${ROUTES.EDIT_POLICY}?id=${item.policyId}`);
  };

  resetFilters = (): void => {
    this.setState({ search: DEFAULT_QUERY_PARAMS.search, query: Query.parse(DEFAULT_QUERY_PARAMS.search) });
  };

  render() {
    const {
      totalManagedIndices,
      search,
      sortField,
      sortDirection,
      selectedItems,
      managedIndices,
      loadingManagedIndices,
      showDataStreams,
      isDataStreamColumnVisible,
    } = this.state;

    const filterIsApplied = !!search;

    const pagination: Pagination = {
      initialPageSize: 20,
      pageSizeOptions: DEFAULT_PAGE_SIZE_OPTIONS,
      totalItemCount: totalManagedIndices,
    };

    const sorting: EuiTableSortingType<ManagedIndexItem> = {
      sort: {
        direction: sortDirection,
        field: sortField,
      },
    };

    const selection: EuiTableSelectionType<ManagedIndexItem> = {
      onSelectionChange: this.onSelectionChange,
    };

    const isRetryDisabled =
      !selectedItems.length ||
      selectedItems.some((item): boolean => {
        if (!item.managedIndexMetaData) return true;
        const { retryInfo, action } = item.managedIndexMetaData;
        return !(retryInfo && retryInfo.failed) && !(action && action.failed);
      });

    // Editing the rollover alias for a data stream shouldn't be allowed.
    const isDataStreamIndexSelected = selectedItems.some((item) => item.dataStream !== null);

    const actions = [
      {
        text: "Edit rollover alias",
        buttonProps: { disabled: selectedItems.length !== 1 || isDataStreamIndexSelected },
        modal: {
          onClickModal: (onShow: (component: any, props: object) => void) => () =>
            onShow(RolloverAliasModal, {
              index: selectedItems[0].index,
              core: this.context,
            }),
        },
      },
      {
        text: "Remove policy",
        buttonProps: { disabled: !selectedItems.length },
        modal: {
          onClickModal: (onShow: (component: any, props: object) => void) => () =>
            onShow(ConfirmationModal, {
              title: `Remove ${
                selectedItems.length === 1 ? `policy from ${selectedItems[0].index}` : `policies from ${selectedItems.length} indices`
              }`,
              bodyMessage: `Remove ${
                selectedItems.length === 1 ? `policy from ${selectedItems[0].index}` : `policies from ${selectedItems.length} indices`
              } permanently? This action cannot be undone.`,
              actionMessage: "Remove",
              onAction: () => this.onClickRemovePolicy(selectedItems.map((item) => item.index)),
            }),
        },
      },
      {
        text: "Retry policy",
        buttonProps: { disabled: isRetryDisabled },
        modal: {
          onClickModal: (onShow: (component: any, props: object) => void) => () =>
            onShow(RetryModal, {
              retryItems: _.cloneDeep(selectedItems),
            }),
        },
      },
    ];

    const searchControl = {
      toolsRight: (
        <ManagedIndexControls
          onRefresh={this.getManagedIndices}
          showDataStreams={showDataStreams}
          getDataStreams={this.getDataStreams}
          toggleShowDataStreams={this.toggleShowDataStreams}
        />
      ),
      box: { placeholder: "Search index name", SEARCH_SCHEMA, incremental: true },
      filters: showDataStreams
        ? [
            {
              type: "field_value_selection",
              field: "data_streams",
              name: "Data streams",
              noOptionsMessage: "No data streams found",
              multiSelect: false,
              cache: 60000,
              options: () => this.getDataStreams(),
            },
          ]
        : undefined,
    };

    return (
      <div style={{ padding: "0px 25px" }}>
        <EuiFlexGroup alignItems="center">
          <EuiFlexItem>
            <EuiTitle size="l">
              <h1>Managed Indices</h1>
            </EuiTitle>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton href={`${PLUGIN_NAME}#/change-policy`} data-test-subj="changePolicyButton">
              Change policy
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer />

        <ContentPanel actions={<ContentPanelActions actions={actions} />} bodyStyles={{ padding: "initial" }} title="Indices">
          <EuiInMemoryTable
            columns={this.managedIndicesColumns(isDataStreamColumnVisible)}
            isSelectable={true}
            itemId="index"
            items={managedIndices}
            noItemsMessage={
              <ManagedIndexEmptyPrompt
                history={this.props.history}
                filterIsApplied={filterIsApplied}
                loading={loadingManagedIndices}
                resetFilters={this.resetFilters}
              />
            }
            search={searchControl}
            pagination={pagination}
            selection={selection}
            sorting={sorting}
            childrenBetween={<EuiHorizontalRule margin="xs" />}
          />
        </ContentPanel>
      </div>
    );
  }
}
